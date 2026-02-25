/**
 * Scout phase for auto mode: build context, execute scout, handle results.
 */

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
import { formatGuidelinesForPrompt } from './guidelines.js';
import { selectRelevant, formatLearningsForPrompt, extractTags, addLearning } from './learnings.js';
import { formatIndexForPrompt } from './codebase-index.js';
import { formatDedupForPrompt } from './dedup-memory.js';
import { buildScoutEscalation } from './wave-scheduling.js';
import { ScoutPromptBuilder } from './scout-prompt-builder.js';
import {
  recordScanResult, saveSectors, computeCoverage, buildSectorSummary,
  getSectorDifficulty, getSectorCategoryAffinity,
} from './sectors.js';
import { getDeduplicationContext } from './dedup.js';
import { buildCycleContextBlock } from './cycle-context.js';
import { formatTasteForPrompt } from './taste-profile.js';
import { formatGoalContext } from './goals.js';
import { sleep } from './dedup.js';
import { buildBaselineHealthBlock } from './qa-stats.js';
import { formatTrajectoryForPrompt } from '@promptwheel/core/trajectory/shared';
import { appendErrorLedger, analyzeErrorLedger } from './error-ledger.js';
import { recordLensScan, recordZeroYield } from './lens-rotation.js';

export interface ScoutResult {
  proposals: TicketProposal[];
  scoutResult: Awaited<ReturnType<typeof scoutRepo>>;
  scope: string;
  cycleFormula: import('./formulas.js').Formula | null;
  isDeepCycle: boolean;
  isDocsAuditCycle: boolean;
  shouldRetry: boolean;
  shouldBreak: boolean;
  scoutDurationMs?: number;
}

export async function runScoutPhase(state: AutoSessionState, preSelectedScope?: string): Promise<ScoutResult> {
  // Trajectory step scope overrides sector-based scope
  const trajectoryScope = state.currentTrajectoryStep?.scope;
  const scope = trajectoryScope ?? preSelectedScope ?? getNextScope(state);

  // Map trajectory scope to a sector so stats stay current
  if (trajectoryScope && state.sectorState && !state.currentSectorId) {
    const normalizedScope = trajectoryScope.replace(/\/\*\*$/, '').replace(/\/$/, '');
    const matchedSector = state.sectorState.sectors.find(s =>
      normalizedScope.startsWith(s.path) || s.path.startsWith(normalizedScope),
    );
    if (matchedSector) {
      state.currentSectorId = matchedSector.path;
    }
  }

  // No sectors need scanning — all covered and no changes detected
  if (scope === null) {
    if (state.lensFullyExhausted) {
      state.displayAdapter.log(chalk.gray(`  All sectors scanned across ${state.lensRotation.length} lens(es). Waiting for new code...`));
    } else {
      state.displayAdapter.log(chalk.gray('  All sectors scanned, no changes detected. Waiting for new code...'));
    }
    // Sleep before retrying so we don't spin
    await new Promise(r => setTimeout(r, 30_000));
    return {
      proposals: [],
      scoutResult: { proposals: [], project: state.project, scannedFiles: 0, errors: [], durationMs: 0, success: true, run: {} as never, tickets: [] },
      scope: '**',
      cycleFormula: null,
      isDeepCycle: false,
      isDocsAuditCycle: false,
      shouldRetry: false,
      shouldBreak: false,
    };
  }

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

  // Show active lens when not default
  if (state.currentLens !== 'default') {
    state.displayAdapter.log(chalk.cyan(`  Lens: ${state.currentLens}`));
  }

  await getDeduplicationContext(state.adapter, state.project.id, state.repoRoot);

  const cycleFormula = state.getCycleFormula(state.cycleCount);
  state.currentFormulaName = cycleFormula?.name ?? 'default';
  const { allow: allowCategories, block: blockCategories } = state.getCycleCategories(cycleFormula);

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

  const isDeepCycle = cycleFormula?.name === 'deep' && cycleFormula !== state.activeFormula;
  const isDocsAuditCycle = cycleFormula?.name === 'docs-audit' && cycleFormula !== state.activeFormula;

  const cycleSuffix = isDeepCycle ? ' 🔬 deep' : isDocsAuditCycle ? ' 📄 docs-audit' : '';
  const cycleLabel = state.maxCycles > 1 || state.runMode === 'spin'
    ? `[Cycle ${state.cycleCount}]${cycleSuffix} `
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

  if (state.guidelines) promptBuilder.addGuidelines(formatGuidelinesForPrompt(state.guidelines));
  if (state.metadataBlock) promptBuilder.addMetadata(state.metadataBlock);
  if (state.tasteProfile) promptBuilder.addTasteProfile(formatTasteForPrompt(state.tasteProfile));
  if (state.activeGoal && state.activeGoalMeasurement) {
    promptBuilder.addGoalContext(formatGoalContext(state.activeGoal, state.activeGoalMeasurement));
  }
  if (state.activeTrajectory && state.activeTrajectoryState && state.currentTrajectoryStep) {
    promptBuilder.addTrajectoryContext(
      formatTrajectoryForPrompt(state.activeTrajectory, state.activeTrajectoryState.stepStates, state.currentTrajectoryStep),
    );
  }
  if (state.codebaseIndex) promptBuilder.addCodebaseIndex(formatIndexForPrompt(state.codebaseIndex, state.cycleCount));
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
      const lensInfo = state.lensRotation.length > 1
        ? `\nActive lens: ${state.currentLens} (${state.lensIndex + 1}/${state.lensRotation.length})`
        : '';
      promptBuilder.addSessionSummary(
        `<session-summary>\nSession: cycle ${state.cycleCount}, ${completed} succeeded, ${failed} failed, ${noChanges} no-changes${lensInfo}\nSession phase: ${state.sessionPhase}\n</session-summary>`,
      );
    }
  }

  const baselineHealthBlock = buildBaselineHealthBlock(state.repoRoot, scope);
  if (baselineHealthBlock) promptBuilder.addBaselineHealth(baselineHealthBlock);

  if (state.scoutRetries > 0) {
    promptBuilder.addEscalation(buildScoutEscalation(state.scoutRetries, state.scoutedDirs, state.codebaseIndex, state.sectorState ?? undefined));
  }
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
    const learningsText = formatLearningsForPrompt(selectRelevant(state.allLearnings, { paths: [scope] }), state.autoConf.learningsBudget);
    if (learningsText) promptBuilder.addLearnings(learningsText);
  }
  if (cycleFormula?.prompt) promptBuilder.addFormulaPrompt(cycleFormula.prompt);
  if (hintBlock) promptBuilder.addHints(hintBlock);

  const effectivePrompt = promptBuilder.build();

  // Coverage context
  const coverageCtx = state.sectorState && state.currentSectorId
    ? (() => {
        const cov = computeCoverage(state.sectorState!);
        const sec = state.sectorState!.sectors.find(s => s.path === state.currentSectorId);
        return {
          sectorPath: state.currentSectorId!,
          scannedSectors: cov.scannedSectors,
          totalSectors: cov.totalSectors,
          percent: cov.percent,
          sectorPercent: cov.sectorPercent,
          classificationConfidence: sec?.classificationConfidence ?? 'low',
          scanCount: sec?.scanCount ?? 0,
          proposalYield: sec?.proposalYield ?? 0,
          sectorSummary: buildSectorSummary(state.sectorState!, state.currentSectorId!),
          sectorDifficulty: sec ? getSectorDifficulty(sec) : undefined,
          sectorCategoryAffinity: sec ? getSectorCategoryAffinity(sec) : undefined,
        };
      })()
    : undefined;

  let scoutResult;
  const scoutStart = Date.now();
  try {
    scoutResult = await scoutRepo(state.deps, {
      path: scoutPath,
      scope,
      types: allowCategories.length <= 4 ? allowCategories as ProposalCategory[] : undefined,
      excludeTypes: allowCategories.length > 4 ? blockCategories as ProposalCategory[] : undefined,
      maxProposals: 20,
      minConfidence: state.effectiveMinConfidence,
      model: state.options.scoutBackend === 'codex' ? undefined : (state.options.eco ? 'sonnet' : ((cycleFormula?.model as 'opus' | 'haiku' | 'sonnet') ?? 'opus')),
      customPrompt: effectivePrompt,
      autoApprove: false,
      backend: state.scoutBackend,
      protectedFiles: ['.promptwheel/**', ...(state.options.includeClaudeMd ? [] : ['CLAUDE.md', '.claude/**'])],
      batchTokenBudget: state.batchTokenBudget,
      timeoutMs: state.endTime ? 0 : state.scoutTimeoutMs,
      maxFiles: state.maxScoutFiles,
      scoutConcurrency: state.scoutConcurrency,
      coverageContext: coverageCtx,
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
        formula: state.currentFormulaName,
      });
    } catch { /* non-fatal */ }
    throw scoutErr;
  }

  // Record scan
  if (state.sectorState && state.currentSectorId) {
    recordScanResult(state.sectorState, state.currentSectorId, state.currentSectorCycle, scoutResult.proposals.length, scoutResult.sectorReclassification);
    saveSectors(state.repoRoot, state.sectorState);
    const cov = computeCoverage(state.sectorState);
    if (state.options.verbose) {
      state.displayAdapter.log(chalk.gray(`  Sector: ${state.currentSectorId} (${cov.scannedSectors}/${cov.totalSectors} scanned, ${cov.percent}% coverage)`));
      if (cov.sectorPercent >= 100) {
        state.displayAdapter.log(chalk.gray(`  Full coverage — sector fully scanned`));
      }
    }
  }

  // Record lens scan and zero-yield tracking
  recordLensScan(state);

  // Mark sectors with no scannable files so they're never re-selected
  if (scoutResult.scannedFiles === 0 && state.sectorState && state.currentSectorId) {
    const sector = state.sectorState.sectors.find(s => s.path === state.currentSectorId);
    if (sector) {
      sector.fileCount = 0;
      sector.productionFileCount = 0;
      saveSectors(state.repoRoot, state.sectorState);
    }
  }

  const proposals = scoutResult.proposals;
  recordZeroYield(state, proposals.length);

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
      return { proposals: [], scoutResult, scope, cycleFormula, isDeepCycle, isDocsAuditCycle, shouldRetry: false, shouldBreak: false };
    }

    // CLI gets more retries than MCP plugin since it's a longer-running standalone process
    const maxRetries = SCOUT_DEFAULTS.MAX_SCOUT_RETRIES + 2;
    if (state.scoutRetries < maxRetries) {
      state.scoutRetries++;
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  No improvements found in ${scope} (attempt ${state.scoutRetries}/${maxRetries + 1}). Retrying with fresh approach...`));
      await sleep(1000);
      return { proposals: [], scoutResult, scope, cycleFormula, isDeepCycle, isDocsAuditCycle, shouldRetry: true, shouldBreak: false };
    }
    state.scoutRetries = 0;
    state.scoutedDirs = [];
    if (state.runMode === 'spin') {
      await sleep(2000);
    }
    const covMsg = state.sectorState
      ? (() => { const c = computeCoverage(state.sectorState!); return ` (${c.scannedSectors}/${c.totalSectors} sectors scanned, ${c.percent}% coverage)`; })()
      : '';
    state.displayAdapter.log(chalk.green(`✓ No improvements found in this sector${covMsg}`));
    // Let shouldContinue() decide whether to loop or stop
    return { proposals: [], scoutResult, scope, cycleFormula, isDeepCycle, isDocsAuditCycle, shouldRetry: true, shouldBreak: false };
  }

  state.displayAdapter.scoutCompleted(proposals.length);
  const scoutDurationMs = Date.now() - scoutStart;
  return { proposals, scoutResult, scope, cycleFormula, isDeepCycle, isDocsAuditCycle, shouldRetry: false, shouldBreak: false, scoutDurationMs };
}
