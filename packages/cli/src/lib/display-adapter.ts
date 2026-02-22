/**
 * DisplayAdapter — abstraction over all UI output during auto mode.
 *
 * Two implementations:
 * - SpinnerDisplayAdapter: wraps current spinner + console.log behavior (default)
 * - TuiDisplayAdapter: drives the neo-blessed TUI (opt-in via --tui)
 */

export interface SessionInfo {
  version: string;
  deliveryMode: string;
  scope: string;
  isContinuous: boolean;
  endTime?: number;
  startTime: number;
  maxPrs: number;
}

export interface BatchStatus {
  index: number;
  status: 'waiting' | 'running' | 'done' | 'failed';
  proposals?: number;
  durationMs?: number;
  error?: string;
}

export interface ProgressSnapshot {
  phase: 'scouting' | 'filtering' | 'executing' | 'idle';
  cycleCount: number;
  ticketsDone: number;
  ticketsFailed: number;
  ticketsDeferred: number;
  ticketsActive: number;
  elapsedMs: number;
  timeBudgetMs?: number;
  sectorCoverage?: {
    scanned: number;
    total: number;
    percent: number;
  };
}

export interface DisplayAdapter {
  // Session lifecycle
  sessionStarted(info: SessionInfo): void;
  sessionEnded(): void;

  // Scout phase
  scoutStarted(scope: string, cycle: number): void;
  scoutProgress(msg: string): void;
  scoutBatchProgress(statuses: BatchStatus[], totalBatches: number, totalProposals: number): void;
  scoutCompleted(proposalCount: number): void;
  scoutFailed(error: string): void;
  scoutRawOutput(chunk: string): void;

  // Ticket execution
  ticketAdded(id: string, title: string, slotLabel: string): void;
  ticketProgress(id: string, msg: string): void;
  ticketRawOutput(id: string, chunk: string): void;
  ticketDone(id: string, success: boolean, msg: string): void;

  // Generic output (replaces console.log in pipeline)
  log(msg: string): void;

  // Drill state
  drillStateChanged(info: { active: boolean; trajectoryName?: string; trajectoryProgress?: string; ambitionLevel?: string } | null): void;

  // Progress status bar
  progressUpdate(snapshot: ProgressSnapshot): void;

  // Lifecycle
  destroy(): void;
}

// ── Shared rendering helpers ─────────────────────────────────────────────────

/** Render a progress bar: `████████░░░░` */
export function renderProgressBar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Format milliseconds as compact elapsed: `12s`, `3m`, `1h12m` */
export function formatCompactElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
}

/** Format a full progress line: bar + cycle + time + counts + phase */
export function formatProgressLine(snapshot: ProgressSnapshot): string {
  const parts: string[] = [];

  // Progress bar (if denominator available)
  if (snapshot.timeBudgetMs && snapshot.timeBudgetMs > 0) {
    const pct = Math.min(100, (snapshot.elapsedMs / snapshot.timeBudgetMs) * 100);
    parts.push(`${renderProgressBar(pct)} ${Math.round(pct)}%`);
  } else if (snapshot.sectorCoverage && snapshot.sectorCoverage.total > 0) {
    parts.push(`${renderProgressBar(snapshot.sectorCoverage.percent)} ${Math.round(snapshot.sectorCoverage.percent)}%`);
  }

  // Cycle
  if (snapshot.cycleCount > 0) {
    parts.push(`Cycle ${snapshot.cycleCount}`);
  }

  // Time
  if (snapshot.timeBudgetMs && snapshot.timeBudgetMs > 0) {
    parts.push(`${formatCompactElapsed(snapshot.elapsedMs)} / ${formatCompactElapsed(snapshot.timeBudgetMs)}`);
  } else if (snapshot.sectorCoverage && snapshot.sectorCoverage.total > 0) {
    parts.push(`${snapshot.sectorCoverage.scanned}/${snapshot.sectorCoverage.total} sectors`);
  } else {
    parts.push(formatCompactElapsed(snapshot.elapsedMs));
  }

  // Counts
  const counts: string[] = [];
  if (snapshot.ticketsDone > 0) counts.push(`${snapshot.ticketsDone} done`);
  if (snapshot.ticketsFailed > 0) counts.push(`${snapshot.ticketsFailed} failed`);
  if (snapshot.ticketsDeferred > 0) counts.push(`${snapshot.ticketsDeferred} deferred`);
  if (counts.length > 0) parts.push(counts.join(' · '));

  // Phase
  const phaseLabel = snapshot.phase.charAt(0).toUpperCase() + snapshot.phase.slice(1);
  if (snapshot.ticketsActive > 0) {
    parts.push(`${phaseLabel} (${snapshot.ticketsActive} active)`);
  } else {
    parts.push(phaseLabel);
  }

  return parts.join(' │ ');
}
