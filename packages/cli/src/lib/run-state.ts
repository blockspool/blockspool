/**
 * Persistent run state for cross-session cycle tracking.
 *
 * Stored in `.promptwheel/run-state.json`. Tracks how many scout cycles
 * have run so periodic tasks (like docs-audit) can trigger automatically.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CycleSummary } from './cycle-context.js';

export interface DeferredProposal {
  category: string;
  title: string;
  description: string;
  files: string[];
  allowed_paths: string[];
  confidence: number;
  impact_score: number;
  original_scope: string;
  deferredAt: number;
  deferredAtCycle?: number;
}

export interface CategorySuccessStats {
  proposals: number;
  success: number;
  failure: number;
  successRate: number;
  confidenceAdjustment: number;
  lastUpdatedCycle: number;
}

export interface RunState {
  /** Total scout cycles completed (persists across sessions) */
  totalCycles: number;
  /** Cycle number of the last docs-audit run */
  lastDocsAuditCycle: number;
  /** Timestamp of last run */
  lastRunAt: number;
  /** Proposals deferred because they were outside the session scope */
  deferredProposals: DeferredProposal[];
  /** Recent cycle summaries for convergence-aware prompting */
  recentCycles?: CycleSummary[];
  /** Recent diff summaries for follow-up proposal generation */
  recentDiffs?: Array<{ title: string; summary: string; files: string[]; cycle: number }>;
  /** Execution quality signals for confidence calibration */
  qualitySignals?: {
    totalTickets: number;
    firstPassSuccess: number;
    retriedSuccess: number;
    qaPassed: number;
    qaFailed: number;
  };
  /** Per-category success/failure stats for confidence calibration */
  categoryStats?: Record<string, CategorySuccessStats>;
  /** Persisted confidence calibration from last session */
  lastEffectiveMinConfidence?: number;
  /** Persisted drill consecutive insufficient count */
  lastDrillConsecutiveInsufficient?: number;
  /** Session crash-resume checkpoint — restored if recent enough */
  sessionCheckpoint?: {
    cycleCount: number;
    totalPrsCreated: number;
    totalFailed: number;
    consecutiveLowYieldCycles: number;
    pendingPrUrls: string[];
    allPrUrls: string[];
    ticketOutcomeSummary: Array<{ title: string; category: string; status: string }>;
    savedAt: number;
  };
}

const RUN_STATE_FILE = 'run-state.json';

function statePath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', RUN_STATE_FILE);
}

// ── Async mutex to prevent concurrent read-modify-write races ───────────
// During parallel ticket execution, multiple recordX functions may fire
// concurrently. Without serialisation the second reader can snapshot stale
// state before the first writer flushes, silently dropping data.
//
// The lock is intentionally per-process (module-level). File-level locking
// (e.g. flock) is unnecessary because all callers live in the same Node
// process; a simple promise-chain mutex is sufficient and zero-dep.
let _writeLock: Promise<void> = Promise.resolve();

function withRunStateLock<T>(fn: () => T): Promise<T> {
  const prev = _writeLock;
  let release!: () => void;
  _writeLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release());
}

const DEFAULT_STATE: RunState = {
  totalCycles: 0,
  lastDocsAuditCycle: 0,
  lastRunAt: 0,
  deferredProposals: [],
  recentCycles: [],
  recentDiffs: [],
};

/**
 * Read the current run state from disk.
 */
export function readRunState(repoRoot: string): RunState {
  const fp = statePath(repoRoot);
  if (!fs.existsSync(fp)) return { ...DEFAULT_STATE };

  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      totalCycles: parsed.totalCycles ?? 0,
      lastDocsAuditCycle: parsed.lastDocsAuditCycle ?? 0,
      lastRunAt: parsed.lastRunAt ?? 0,
      deferredProposals: Array.isArray(parsed.deferredProposals) ? parsed.deferredProposals : [],
      recentCycles: Array.isArray(parsed.recentCycles) ? parsed.recentCycles : [],
      recentDiffs: Array.isArray(parsed.recentDiffs) ? parsed.recentDiffs : [],
      qualitySignals: parsed.qualitySignals ?? undefined,
      categoryStats: parsed.categoryStats ?? undefined,
      lastEffectiveMinConfidence: typeof parsed.lastEffectiveMinConfidence === 'number' ? parsed.lastEffectiveMinConfidence : undefined,
      lastDrillConsecutiveInsufficient: typeof parsed.lastDrillConsecutiveInsufficient === 'number' ? parsed.lastDrillConsecutiveInsufficient : undefined,
      sessionCheckpoint: parsed.sessionCheckpoint ?? undefined,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Write the run state to disk.
 */
export function writeRunState(repoRoot: string, state: RunState): void {
  const fp = statePath(repoRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, fp);
}

/**
 * Increment the cycle counter and return the new state.
 *
 * This function remains synchronous because callers use its return value
 * directly (e.g. `updatedRunState.totalCycles`). It is only called from
 * the sequential post-cycle path, never from parallel ticket execution,
 * so it does not need the async mutex.
 */
export function recordCycle(repoRoot: string): RunState {
  const state = readRunState(repoRoot);
  state.totalCycles += 1;
  state.lastRunAt = Date.now();
  writeRunState(repoRoot, state);
  return state;
}

/**
 * Check if a docs-audit cycle is due.
 * Returns true every N cycles since the last docs-audit.
 */
export function isDocsAuditDue(repoRoot: string, interval: number = 3): boolean {
  const state = readRunState(repoRoot);
  return (state.totalCycles - state.lastDocsAuditCycle) >= interval;
}

/**
 * Record that a docs-audit was run.
 */
export function recordDocsAudit(repoRoot: string): Promise<void> {
  return withRunStateLock(() => {
    const state = readRunState(repoRoot);
    state.lastDocsAuditCycle = state.totalCycles;
    writeRunState(repoRoot, state);
  });
}

/** Max age for deferred proposals (7 days) */
const MAX_DEFERRED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Promote out-of-scope proposals after ~2 full cycles */
const PROMOTION_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Defer a proposal for later when the scope matches.
 */
export function deferProposal(repoRoot: string, proposal: DeferredProposal): Promise<void> {
  return withRunStateLock(() => {
    const state = readRunState(repoRoot);

    // Avoid duplicates by title
    if (state.deferredProposals.some(d => d.title === proposal.title)) return;

    // File-overlap dedup: if an existing deferred proposal targets the same
    // primary files, replace it (fresher description, updated timestamp).
    const proposalFiles = new Set(proposal.allowed_paths);
    if (proposalFiles.size > 0) {
      const overlapIdx = state.deferredProposals.findIndex(d => {
        const existingFiles = new Set(d.allowed_paths);
        if (existingFiles.size === 0 || proposalFiles.size === 0) return false;
        if (existingFiles.size !== proposalFiles.size) return false;
        for (const f of proposalFiles) {
          if (!existingFiles.has(f)) return false;
        }
        return true;
      });
      if (overlapIdx !== -1) {
        state.deferredProposals[overlapIdx] = proposal;
        writeRunState(repoRoot, state);
        return;
      }
    }

    state.deferredProposals.push(proposal);
    writeRunState(repoRoot, state);
  });
}

/**
 * Retrieve and remove deferred proposals that now match the given scope.
 * Also prunes proposals older than 7 days.
 *
 * Promotion: proposals that have waited 3+ cycles OR 2+ hours get promoted
 * into the current scope regardless of file match. This ensures proposals
 * targeting root-level files (README.md, etc.) don't sit forever when only
 * sector-scoped cycles run.
 *
 * This function remains synchronous because callers use its return value
 * directly (e.g. `deferred.length`). It is only called from the sequential
 * scout/filter path, never from parallel ticket execution.
 */
export function popDeferredForScope(repoRoot: string, scope: string, currentCycle?: number): DeferredProposal[] {
  const state = readRunState(repoRoot);
  const now = Date.now();
  const normalizedScope = scope.replace(/\*\*$/, '').replace(/\*$/, '').replace(/\/$/, '');

  const matched: DeferredProposal[] = [];
  let remaining: DeferredProposal[] = [];

  for (const dp of state.deferredProposals) {
    // Prune stale
    if (now - dp.deferredAt > MAX_DEFERRED_AGE_MS) continue;

    const files = dp.files.length > 0 ? dp.files : dp.allowed_paths;
    const inScope = !normalizedScope || files.length === 0 || files.every(f =>
      f.startsWith(normalizedScope) || f.startsWith(normalizedScope + '/')
    );

    if (inScope) {
      matched.push(dp);
    } else {
      remaining.push(dp);
    }
  }

  // Promote out-of-scope proposals that have waited long enough.
  // Two triggers: 3+ cycles since deferral, OR 2+ hours wall-clock.
  const PROMOTION_CYCLE_THRESHOLD = 3;
  const stillRemaining: DeferredProposal[] = [];
  for (const dp of remaining) {
    const hasCycleInfo = currentCycle !== undefined && currentCycle !== null
      && dp.deferredAtCycle !== undefined && dp.deferredAtCycle !== null;
    const cycleAge = hasCycleInfo ? currentCycle - dp.deferredAtCycle! : 0;
    if ((hasCycleInfo && cycleAge >= PROMOTION_CYCLE_THRESHOLD) || now - dp.deferredAt > PROMOTION_AGE_MS) {
      matched.push(dp);
    } else {
      stillRemaining.push(dp);
    }
  }
  remaining = stillRemaining;

  if (matched.length > 0 || remaining.length !== state.deferredProposals.length) {
    state.deferredProposals = remaining;
    writeRunState(repoRoot, state);
  }

  return matched;
}

/** Max recent diffs to keep (ring buffer) */
const MAX_RECENT_DIFFS = 10;

/**
 * Push a diff summary to recentDiffs ring buffer.
 */
export function pushRecentDiff(
  projectRoot: string,
  diff: { title: string; summary: string; files: string[]; cycle: number },
): Promise<void> {
  return withRunStateLock(() => {
    const state = readRunState(projectRoot);
    const diffs = state.recentDiffs ?? [];
    diffs.push(diff);
    if (diffs.length > MAX_RECENT_DIFFS) {
      diffs.splice(0, diffs.length - MAX_RECENT_DIFFS);
    }
    state.recentDiffs = diffs;
    writeRunState(projectRoot, state);
  });
}

/**
 * Record an execution quality signal.
 */
export function recordQualitySignal(projectRoot: string, signal: 'first_pass' | 'retried' | 'qa_pass' | 'qa_fail'): Promise<void> {
  return withRunStateLock(() => {
    const state = readRunState(projectRoot);
    const qs = state.qualitySignals ??= { totalTickets: 0, firstPassSuccess: 0, retriedSuccess: 0, qaPassed: 0, qaFailed: 0 };
    switch (signal) {
      case 'first_pass': qs.totalTickets++; qs.firstPassSuccess++; break;
      case 'retried': qs.totalTickets++; qs.retriedSuccess++; break;
      case 'qa_pass': qs.qaPassed++; break;
      case 'qa_fail': qs.qaFailed++; break;
    }
    writeRunState(projectRoot, state);
  });
}

/**
 * Get the first-pass success rate (0-1). Returns 1 if no data.
 */
export function getQualityRate(projectRoot: string): number {
  const state = readRunState(projectRoot);
  const qs = state.qualitySignals;
  if (!qs || qs.totalTickets === 0) return 1;
  return qs.firstPassSuccess / qs.totalTickets;
}

/**
 * Record a category outcome and update confidence adjustment.
 *
 * Uses the enterprise algorithm: round((actualRate - 0.70) / 0.10) * 5, clamped [-20, +20].
 */
export function recordCategoryOutcome(repoRoot: string, category: string, success: boolean): Promise<void> {
  return withRunStateLock(() => {
    const state = readRunState(repoRoot);
    const stats = state.categoryStats ??= {};
    const entry = stats[category] ??= {
      proposals: 0,
      success: 0,
      failure: 0,
      successRate: 0,
      confidenceAdjustment: 0,
      lastUpdatedCycle: 0,
    };

    entry.proposals++;
    if (success) {
      entry.success++;
    } else {
      entry.failure++;
    }
    entry.successRate = entry.proposals > 0 ? entry.success / entry.proposals : 0;
    entry.confidenceAdjustment = Math.round(
      Math.max(-20, Math.min(20, Math.round((entry.successRate - 0.75) / 0.08) * 5))
    );
    entry.lastUpdatedCycle = state.totalCycles;
    writeRunState(repoRoot, state);
  });
}

