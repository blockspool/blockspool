/**
 * Scout phase for auto mode: build context, execute scout, handle results.
 */

import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import type { ScoutProgress } from '@promptwheel/core/services';
import { SCOUT_DEFAULTS } from '@promptwheel/core';
import type { TicketProposal, ProposalCategory } from '@promptwheel/core/scout';
import { scoutRepo } from '@promptwheel/core/services';
import type { AutoSessionState } from './solo-auto-state.js';
import { getNextScope } from './solo-auto-state.js';
import { formatElapsed } from './solo-auto-utils.js';
import { readRunState } from './run-state.js';
import { formatProgress } from './solo-config.js';
import { consumePendingHints } from './solo-hints.js';
import { formatGuidelinesForPrompt, formatMissionForPrompt, loadMission } from './guidelines.js';
import { selectRelevant, formatLearningsForPrompt, extractTags, addLearning } from './learnings.js';
import { formatIndexForPrompt, formatAnalysisForPrompt } from './codebase-index.js';
import { formatDedupForPrompt } from './dedup-memory.js';
import { ScoutPromptBuilder } from './scout-prompt-builder.js';
import { getDeduplicationContext } from './dedup.js';
import { buildCycleContextBlock } from './cycle-context.js';
import { formatGoalContext } from './goals.js';
import { sleep } from './dedup.js';
import { buildBaselineHealthBlock } from './qa-stats.js';
import { formatTrajectoryForPrompt } from '@promptwheel/core/trajectory/shared';
import { appendErrorLedger, analyzeErrorLedger } from './error-ledger.js';
import { loadPortfolio, formatPortfolioForPrompt } from './portfolio.js';

export interface ScoutResult {
  proposals: TicketProposal[];
  scoutResult: Awaited<ReturnType<typeof scoutRepo>>;
  scope: string;
  shouldRetry: boolean;
  shouldBreak: boolean;
  scoutDurationMs?: number;
}

export async function runScoutPhase(state: AutoSessionState, preSelectedScope?: string): Promise<ScoutResult> {
  // Trajectory step scope overrides user/default scope
  const trajectoryScope = state.currentTrajectoryStep?.scope;
  const scope = trajectoryScope ?? preSelectedScope ?? getNextScope(state) ?? '**';

  // Cycle header
  if (state.cycleCount > 1) {
    state.displayAdapter.log('');
    state.displayAdapter.log(chalk.blue(`━━━ Cycle ${state.cycleCount} ━━━`));
    state.displayAdapter.log(chalk.gray(`  Elapsed: ${formatElapsed(Date.now() - state.startTime)}`));
    if (state.milestoneMode) {
      state.displayAdapter.log(chalk.gray(`  Milestone PRs: ${state.totalMilestonePrs}/${state.maxPrs} (${state.totalPrsCreated} tickets merged)`));
    } else if (state.deliveryMode === 'direct') {
      if (state.completedDirectTickets.length > 0) {
        state.displayAdapter.log(chalk.gray(`  Tickets: ${state.completedDirectTickets.length}`));
      }
    } else if (state.totalPrsCreated > 0 || state.maxPrs < 999) {
      const limit = state.maxPrs < 999 ? `/${state.maxPrs}` : '';
      state.displayAdapter.log(chalk.gray(`  PRs created: ${state.totalPrsCreated}${limit}`));
    }
    if (state.endTime) {
      const remaining = Math.max(0, state.endTime - Date.now());
      state.displayAdapter.log(chalk.gray(`  Time remaining: ${formatElapsed(remaining)}`));
    }
    state.displayAdapter.log('');
  }

  await getDeduplicationContext(state.adapter, state.project.id, state.repoRoot);

  const { allow: allowCategories, block: blockCategories } = state.getCycleCategories(null);

  // Trajectory step overrides: narrow scope and categories to current step
  if (state.currentTrajectoryStep) {
    if (state.currentTrajectoryStep.categories && state.currentTrajectoryStep.categories.length > 0) {
      allowCategories.length = 0;
      allowCategories.push(...state.currentTrajectoryStep.categories);
      blockCategories.length = 0;
    }
  }

  // Re-apply QA healing after trajectory override — 'fix' must always be available
  // when baselines are failing, even if the trajectory step restricts categories
  if (state.qaBaseline) {
    const failingCount = [...state.qaBaseline.values()].filter(v => !v).length;
    if (failingCount > 0 && !allowCategories.includes('fix')) {
      allowCategories.push('fix');
      const blockIdx = blockCategories.indexOf('fix');
      if (blockIdx >= 0) blockCategories.splice(blockIdx, 1);
    }
  }

  const cycleLabel = state.maxCycles > 1 || state.runMode === 'spin'
    ? `[Cycle ${state.cycleCount}] `
    : 'Step 1: ';
  state.displayAdapter.scoutStarted(scope, state.cycleCount);
  state.displayAdapter.log(chalk.bold(`${cycleLabel}Scouting ${scope}...`));

  // Apply drill directives before consuming hints
  const { applyDrillDirectives } = await import('./solo-auto-drill.js');
  applyDrillDirectives(state);

  // Consume pending hints
  const hintBlock = consumePendingHints(state.repoRoot);
  if (hintBlock) {
    const hintCount = hintBlock.split('\n').filter(l => l.startsWith('- ')).length;
    state.displayAdapter.log(chalk.yellow(`[Hints] Applying ${hintCount} user hint(s) to this scout cycle`));
  }

  let lastProgress = '';
  const scoutPath = (state.milestoneMode && state.milestoneWorktreePath) ? state.milestoneWorktreePath : state.repoRoot;
  // Build prompt using ScoutPromptBuilder
  const promptBuilder = new ScoutPromptBuilder();

  const mission = loadMission(scoutPath);
  if (mission) promptBuilder.addMission(formatMissionForPrompt(mission));
  if (state.guidelines) promptBuilder.addGuidelines(formatGuidelinesForPrompt(state.guidelines));
  // Inject portfolio context (cross-session project knowledge)
  const portfolio = loadPortfolio(state.repoRoot);
  if (portfolio) promptBuilder.addPortfolio(formatPortfolioForPrompt(portfolio));
  if (state.metadataBlock) promptBuilder.addMetadata(state.metadataBlock);
  if (state.activeGoal && state.activeGoalMeasurement) {
    promptBuilder.addGoalContext(formatGoalContext(state.activeGoal, state.activeGoalMeasurement));
  }
  if (state.activeTrajectory && state.activeTrajectoryState && state.currentTrajectoryStep) {
    promptBuilder.addTrajectoryContext(
      formatTrajectoryForPrompt(state.activeTrajectory, state.activeTrajectoryState.stepStates, state.currentTrajectoryStep),
    );
  }
  if (state.codebaseIndex) promptBuilder.addCodebaseIndex(formatIndexForPrompt(state.codebaseIndex, state.cycleCount));
  if (state.codebaseIndex) {
    const analysisBlock = formatAnalysisForPrompt(state.codebaseIndex, state.cycleCount);
    if (analysisBlock) promptBuilder.addAnalysis(analysisBlock);
  }
  const dedupPrefix = formatDedupForPrompt(state.dedupMemory);
  if (dedupPrefix) promptBuilder.addDedupMemory(dedupPrefix);

  const rs0 = readRunState(state.repoRoot);
  const cycleCtxBlock = buildCycleContextBlock(rs0.recentCycles ?? [], rs0.recentDiffs ?? []);
  if (cycleCtxBlock) promptBuilder.addCycleContext(cycleCtxBlock);

  // Session-level summary block — quick orientation for the scout
  {
    const completed = state.allTicketOutcomes.filter(t => t.status === 'completed').length;
    const failed = state.allTicketOutcomes.filter(t => t.status === 'failed').length;
    const noChanges = state.allTicketOutcomes.filter(t => t.status === 'no_changes').length;
    if (state.cycleCount > 1) {
      promptBuilder.addSessionSummary(
        `<session-summary>\nSession: cycle ${state.cycleCount}, ${completed} succeeded, ${failed} failed, ${noChanges} no-changes\nSession phase: ${state.sessionPhase}\n</session-summary>`,
      );
    }
  }

  const baselineHealthBlock = buildBaselineHealthBlock(state.repoRoot, scope);
  if (baselineHealthBlock) promptBuilder.addBaselineHealth(baselineHealthBlock);

  // Error pattern awareness — avoid proposing work in areas that consistently fail
  try {
    const errorPatterns = analyzeErrorLedger(state.repoRoot, state.startTime);
    if (errorPatterns.length > 0) {
      const lines = errorPatterns.slice(0, 5).map(p =>
        `- ${p.failureType} in "${p.failedCommand}" (${p.count}x)`,
      );
      promptBuilder.addErrorPatterns(
        `<error-patterns>\nRecurring failures this session — avoid proposing work that hits these:\n${lines.join('\n')}\n</error-patterns>`,
      );
    }
  } catch { /* non-fatal */ }
  if (state.autoConf.learningsEnabled) {
    const relevant = selectRelevant(state.allLearnings, { paths: [scope] });
    const learningsText = formatLearningsForPrompt(relevant, state.autoConf.learningsBudget);
    if (learningsText) {
      promptBuilder.addLearnings(learningsText);
      if (state.options.verbose && relevant.length > 0) {
        state.displayAdapter.log(chalk.gray(`  Learnings: ${relevant.length} applied to scout prompt`));
      }
    }
  }
  if (hintBlock) promptBuilder.addHints(hintBlock);

  const effectivePrompt = promptBuilder.build();

  // Incremental scanning: compute changed files since last scout
  const changedFiles = await computeIncrementalFiles(state, scoutPath);

  let scoutResult;
  const scoutStart = Date.now();

  // Standard scout
  if (!scoutResult) {
    try {
      scoutResult = await scoutRepo(state.deps, {
        path: scoutPath,
        scope,
        exclude: state.excludePatterns.length > 0 ? state.excludePatterns : undefined,
        changedFiles,
        types: allowCategories.length <= 4 ? allowCategories as ProposalCategory[] : undefined,
        excludeTypes: allowCategories.length > 4 ? blockCategories as ProposalCategory[] : undefined,
        maxProposals: 20,
        minConfidence: state.effectiveMinConfidence,
        model: state.options.scoutBackend === 'codex' ? undefined : 'opus',
        customPrompt: effectivePrompt,
        autoApprove: false,
        backend: state.scoutBackend,
        protectedFiles: ['.promptwheel/**', ...(state.options.includeClaudeMd ? [] : ['CLAUDE.md', '.claude/**'])],
        batchTokenBudget: state.batchTokenBudget,
        timeoutMs: state.endTime ? 0 : state.scoutTimeoutMs,
        maxFiles: state.maxScoutFiles,
        scoutConcurrency: state.scoutConcurrency,
        moduleGroups: state.codebaseIndex?.modules.map(m => ({
          path: m.path,
          dependencies: state.codebaseIndex!.dependency_edges[m.path],
        })),
        onRawOutput: (_batchIndex: number, chunk: string) => {
          state.displayAdapter.scoutRawOutput(chunk);
        },
        onProgress: (progress: ScoutProgress) => {
          if (progress.batchStatuses && progress.totalBatches && progress.totalBatches > 1) {
            state.displayAdapter.scoutBatchProgress(progress.batchStatuses, progress.totalBatches, progress.proposalsFound ?? 0);
            // Update cycle progress so the status bar reflects batch completion
            const batchesDone = progress.batchStatuses.filter((b: { status: string }) => b.status === 'done' || b.status === 'failed').length;
            state._cycleProgress = { done: batchesDone, total: progress.totalBatches, label: 'batches' };
          } else {
            const formatted = formatProgress(progress);
            if (formatted !== lastProgress) {
              state.displayAdapter.scoutProgress(formatted);
              lastProgress = formatted;
            }
          }
        },
      });
    } catch (scoutErr) {
      state.displayAdapter.scoutFailed('Scout failed');
      // Error ledger for scout failures
      try {
        const errMsg = scoutErr instanceof Error ? scoutErr.message : String(scoutErr);
        appendErrorLedger(state.repoRoot, {
          ts: Date.now(),
          ticketId: '',
          ticketTitle: '',
          failureType: 'unknown',
          failedCommand: 'scoutRepo',
          errorPattern: errMsg.slice(0, 100),
          errorMessage: errMsg.slice(0, 500),
          phase: 'scout',
          sessionCycle: state.cycleCount,
        });
      } catch { /* non-fatal */ }
      throw scoutErr;
    }
  }

  // Always update last scan commit after a successful scan (even if zero proposals)
  updateLastScanCommit(state, scoutPath);

  const proposals = scoutResult.proposals;

  if (proposals.length === 0) {
    if (scoutResult.errors.length > 0) {
      state.displayAdapter.scoutFailed('Scout encountered errors');
      for (const err of scoutResult.errors) {
        state.displayAdapter.log(chalk.yellow(`  ⚠ ${err}`));
      }
      if (scoutResult.errors.length > 0 && state.autoConf.learningsEnabled) {
        for (const err of scoutResult.errors.slice(0, 3)) {
          addLearning(state.repoRoot, {
            text: `Scout error in ${scope}: ${err}`.slice(0, 200),
            category: 'warning',
            source: { type: 'ticket_failure', detail: 'scout_error' },
            tags: extractTags([scope], []),
          });
        }
      }
    } else {
      state.displayAdapter.scoutCompleted(0);
    }
    state.scoutedDirs.push(scope);

    // No files matched scope at all — don't retry, there's nothing to find
    if (scoutResult.scannedFiles === 0) {
      state.scoutRetries = 0;
      state.scoutedDirs = [];
      // If a trajectory step targets a scope with no files, fail it immediately
      if (state.currentTrajectoryStep && state.activeTrajectoryState) {
        const stepState = state.activeTrajectoryState.stepStates[state.currentTrajectoryStep.id];
        if (stepState) {
          stepState.status = 'failed';
          stepState.failureReason = 'no files match scope';
          state.displayAdapter.log(chalk.yellow(`  Trajectory step "${state.currentTrajectoryStep.title}" failed — no files match scope "${scope}"`));
          const { getNextStep } = await import('@promptwheel/core/trajectory/shared');
          const { saveTrajectoryState } = await import('./trajectory.js');
          const next = getNextStep(state.activeTrajectory!, state.activeTrajectoryState.stepStates);
          state.currentTrajectoryStep = next;
          if (next) {
            state.activeTrajectoryState.currentStepId = next.id;
            if (state.activeTrajectoryState.stepStates[next.id]) {
              state.activeTrajectoryState.stepStates[next.id].status = 'active';
            }
            state.displayAdapter.log(chalk.cyan(`  -> Skipping to next step: ${next.title}`));
          } else {
            state.displayAdapter.log(chalk.yellow(`  Trajectory "${state.activeTrajectory!.name}" ended (no remaining steps)`));
            if (state.drillMode) {
              const { recordDrillTrajectoryOutcome } = await import('./solo-auto-drill.js');
              const traj = state.activeTrajectory!;
              const stepStates = state.activeTrajectoryState.stepStates;
              const stepsCompleted = Object.values(stepStates).filter(s => s.status === 'completed').length;
              const stepsFailed = Object.values(stepStates).filter(s => s.status === 'failed').length;
              try { recordDrillTrajectoryOutcome(state, traj.name, traj.description, traj.steps.length, stepsCompleted, stepsFailed, 'stalled', traj.steps); } catch { /* non-fatal */ }
            }
            state.activeTrajectory = null;
            state.activeTrajectoryState = null;
            state.currentTrajectoryStep = null;
          }
          if (state.activeTrajectoryState) saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
        }
      }
      return { proposals: [], scoutResult, scope, shouldRetry: false, shouldBreak: false };
    }

    // CLI gets more retries than MCP plugin since it's a longer-running standalone process
    const maxRetries = SCOUT_DEFAULTS.MAX_SCOUT_RETRIES + 2;
    if (state.scoutRetries < maxRetries) {
      state.scoutRetries++;
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  No improvements found in ${scope} (attempt ${state.scoutRetries}/${maxRetries + 1}). Retrying with fresh approach...`));
      await sleep(1000);
      return { proposals: [], scoutResult, scope, shouldRetry: true, shouldBreak: false };
    }
    state.scoutRetries = 0;
    state.scoutedDirs = [];
    if (state.runMode === 'spin') {
      await sleep(2000);
    }
    state.displayAdapter.log(chalk.green(`✓ No improvements found in scope "${scope}"`));
    // Let shouldContinue() decide whether to loop or stop
    return { proposals: [], scoutResult, scope, shouldRetry: true, shouldBreak: false };
  }

  state.displayAdapter.scoutCompleted(proposals.length);
  const scoutDurationMs = Date.now() - scoutStart;
  return { proposals, scoutResult, scope, shouldRetry: false, shouldBreak: false, scoutDurationMs };
}

// ── Incremental scanning helpers ──────────────────────────────────────────

/**
 * Get the current HEAD commit SHA.
 */
function getHeadCommit(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get files changed since a given commit SHA.
 */
function getChangedFilesSince(repoRoot: string, sinceCommit: string): string[] | null {
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${sinceCommit}..HEAD`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return null; // fallback to full scan
  }
}

/**
 * Expand changed files to include their dependents from the codebase index.
 * If file A changed and module B imports from module A, include B too.
 */
function expandWithDependents(changedFiles: string[], state: AutoSessionState): string[] {
  if (!state.codebaseIndex?.reverse_edges) return changedFiles;

  const expanded = new Set(changedFiles);
  const reverseEdges = state.codebaseIndex.reverse_edges;

  for (const file of changedFiles) {
    // Find which module this file belongs to
    const normalized = file.replace(/\\/g, '/');
    for (const mod of state.codebaseIndex.modules) {
      const modPath = mod.path.replace(/\\/g, '/');
      if (normalized === modPath || normalized.startsWith(modPath + '/')) {
        // Add all modules that import this one
        const dependents = reverseEdges[mod.path];
        if (dependents) {
          for (const dep of dependents) {
            // Add the module directory as a prefix — scanner will match files within
            expanded.add(dep);
            // Also add any files we know about in that module
            for (const otherMod of state.codebaseIndex!.modules) {
              if (otherMod.path === dep) {
                expanded.add(otherMod.path);
              }
            }
          }
        }
        break;
      }
    }
  }

  return [...expanded];
}

/**
 * Compute the set of files to scan incrementally, or undefined for a full scan.
 *
 * Returns undefined (full scan) when:
 * - First cycle (no lastScanCommit)
 * - git diff fails
 * - Changed files exceed 30% of repo (incremental is pointless)
 * - Deep or docs-audit cycle (needs full view)
 */
async function computeIncrementalFiles(state: AutoSessionState, scoutPath: string): Promise<string[] | undefined> {
  // Skip incremental on first cycle, deep cycles, or when explicitly disabled
  if (!state.lastScanCommit) return undefined;
  if (state.cycleCount <= 1) return undefined;

  const headCommit = getHeadCommit(scoutPath);
  if (!headCommit || headCommit === state.lastScanCommit) {
    // No changes since last scan — still do a full scan to find new improvements
    // (the scout prompt changes each cycle via learnings, escalation, etc.)
    return undefined;
  }

  const changed = getChangedFilesSince(scoutPath, state.lastScanCommit);
  if (!changed || changed.length === 0) return undefined;

  // If too many files changed, fall back to full scan
  const totalModules = state.codebaseIndex?.modules.length ?? 100;
  if (changed.length > totalModules * 0.3) {
    return undefined;
  }

  // Expand with dependents
  const expanded = expandWithDependents(changed, state);

  if (state.options.verbose) {
    state.displayAdapter.log(chalk.gray(`  Incremental: ${changed.length} changed, ${expanded.length} after dependents`));
  }

  return expanded;
}

/**
 * Record the current HEAD as the last scan commit.
 */
function updateLastScanCommit(state: AutoSessionState, scoutPath: string): void {
  const head = getHeadCommit(scoutPath);
  if (head) {
    state.lastScanCommit = head;
  }
}

