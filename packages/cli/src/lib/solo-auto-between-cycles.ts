/**
 * Pre-cycle and post-cycle maintenance for auto mode.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import type { AutoSessionState } from './solo-auto-state.js';
import { readRunState, writeRunState, recordCycle, recordDocsAudit, getQualityRate, snapshotLearningROI } from './run-state.js';
import { getSessionPhase } from './solo-auto-utils.js';
import {
  checkPrStatuses,
  fetchPrReviewComments,
  deleteTicketBranch,
  deleteRemoteBranch,
} from './solo-git.js';
import { loadGuidelines } from './guidelines.js';
import { addLearning, loadLearnings, consolidateLearnings, extractTags } from './learnings.js';
import { captureQaBaseline } from './solo-ticket.js';
import { normalizeQaConfig } from './solo-utils.js';
import { getPromptwheelDir } from './solo-config.js';
import { removePrEntries } from './file-cooldown.js';
import { recordFormulaMergeOutcome } from './run-state.js';
import { updatePrOutcome } from './pr-outcomes.js';
import {
  recordMergeOutcome, saveSectors, refreshSectors,
  suggestScopeAdjustment,
} from './sectors.js';
import { loadDedupMemory } from './dedup-memory.js';
import { calibrateConfidence } from './qa-stats.js';
import { extractMetaLearnings } from './meta-learnings.js';
import {
  refreshCodebaseIndex, hasStructuralChanges,
} from './codebase-index.js';
import {
  pushCycleSummary, computeConvergenceMetrics,
  formatConvergenceOneLiner, type CycleSummary,
} from './cycle-context.js';
import { buildTasteProfile, saveTasteProfile } from './taste-profile.js';
import {
  runMeasurement, measureGoals, pickGoalByGap,
  recordGoalMeasurement,
} from './goals.js';
import { sleep } from './dedup.js';
import { saveTrajectoryState } from './trajectory.js';
import {
  getNextStep as getTrajectoryNextStep,
  trajectoryComplete,
  trajectoryFullySucceeded,
  trajectoryStuck,
} from '@promptwheel/core/trajectory/shared';
import { recordDrillTrajectoryOutcome, computeAmbitionLevel } from './solo-auto-drill.js';

// ── Pre-cycle maintenance ───────────────────────────────────────────────────

export interface PreCycleResult {
  shouldSkipCycle: boolean;
}

export async function runPreCycleMaintenance(state: AutoSessionState): Promise<PreCycleResult> {
  state.cycleCount++;
  state.cycleOutcomes = [];
  // scope is computed in scout phase; pre-cycle doesn't need it

  // Session phase computation
  const totalBudgetMs = state.totalMinutes ? state.totalMinutes * 60 * 1000 : undefined;
  state.sessionPhase = getSessionPhase(Date.now() - state.startTime, totalBudgetMs);

  // Per-sector difficulty calibration
  if (state.sectorState && state.currentSectorId) {
    const { getSectorMinConfidence } = await import('./sectors.js');
    const sec = state.sectorState.sectors.find(s => s.path === state.currentSectorId);
    if (sec) {
      state.effectiveMinConfidence = getSectorMinConfidence(sec, state.autoConf.minConfidence ?? 20);
    }
  }

  // Session phase confidence adjustments
  if (state.sessionPhase === 'warmup') {
    state.effectiveMinConfidence += 10;
  } else if (state.sessionPhase === 'deep') {
    state.effectiveMinConfidence = Math.max(10, state.effectiveMinConfidence - 10);
  }

  // Quality rate confidence boost
  if (state.cycleCount > 2) {
    const qualityRate = getQualityRate(state.repoRoot);
    if (qualityRate < 0.5) {
      state.effectiveMinConfidence += 10;
      if (state.options.verbose) {
        console.log(chalk.gray(`  Quality rate ${(qualityRate * 100).toFixed(0)}% — raising confidence +10`));
      }
    }
  }

  // Stats-based confidence calibration
  if (state.cycleCount > 5) {
    try {
      const confDelta = calibrateConfidence(
        state.repoRoot,
        state.effectiveMinConfidence,
        state.autoConf.minConfidence ?? 20,
      );
      if (confDelta !== 0) {
        state.effectiveMinConfidence += confDelta;
        console.log(chalk.gray(`  Confidence calibration: ${confDelta > 0 ? '+' : ''}${confDelta} → ${state.effectiveMinConfidence}`));
      }
    } catch {
      // Non-fatal
    }
  }

  // Backpressure from open PRs (skip in direct mode)
  if (state.runMode === 'spin' && state.pendingPrUrls.length > 0 && state.deliveryMode !== 'direct') {
    const openRatio = state.pendingPrUrls.length / state.maxPrs;
    if (openRatio > 0.7) {
      console.log(chalk.yellow(`  Backpressure: ${state.pendingPrUrls.length}/${state.maxPrs} PRs open — waiting for reviews...`));
      await sleep(15000);
      state.cycleCount--; // undo increment so the cycle reruns
      return { shouldSkipCycle: true };
    } else if (openRatio > 0.4) {
      state.effectiveMinConfidence += 15;
      if (state.options.verbose) {
        console.log(chalk.gray(`  Light backpressure (${state.pendingPrUrls.length}/${state.maxPrs} open) — raising confidence +15`));
      }
    }
  }

  // Clamp confidence to prevent runaway compounding from stacking adjustments
  const CONFIDENCE_FLOOR = 0;
  const CONFIDENCE_CEILING = 80;
  if (state.effectiveMinConfidence > CONFIDENCE_CEILING) {
    if (state.options.verbose) {
      console.log(chalk.gray(`  Confidence clamped: ${state.effectiveMinConfidence} → ${CONFIDENCE_CEILING} (ceiling)`));
    }
    state.effectiveMinConfidence = CONFIDENCE_CEILING;
  } else if (state.effectiveMinConfidence < CONFIDENCE_FLOOR) {
    state.effectiveMinConfidence = CONFIDENCE_FLOOR;
  }

  // Rebuild taste profile every 10 cycles
  if (state.cycleCount % 10 === 0 && state.sectorState) {
    const rs = readRunState(state.repoRoot);
    state.tasteProfile = buildTasteProfile(state.sectorState, state.allLearnings, rs.formulaStats);
    saveTasteProfile(state.repoRoot, state.tasteProfile);
    if (state.options.verbose) {
      console.log(chalk.gray(`  Taste profile rebuilt: prefer [${state.tasteProfile.preferredCategories.join(', ')}], avoid [${state.tasteProfile.avoidCategories.join(', ')}]`));
    }
  }

  // Periodic pull
  if (state.pullInterval > 0 && state.runMode === 'spin') {
    state.cyclesSinceLastPull++;
    if (state.cyclesSinceLastPull >= state.pullInterval) {
      state.cyclesSinceLastPull = 0;
      try {
        const fetchResult = spawnSync(
          'git', ['fetch', 'origin', state.detectedBaseBranch],
          { cwd: state.repoRoot, encoding: 'utf-8', timeout: 30000 },
        );

        if (fetchResult.status === 0) {
          const mergeResult = spawnSync(
            'git', ['merge', '--ff-only', `origin/${state.detectedBaseBranch}`],
            { cwd: state.repoRoot, encoding: 'utf-8' },
          );

          if (mergeResult.status === 0) {
            const summary = mergeResult.stdout?.trim();
            if (summary && !summary.includes('Already up to date')) {
              console.log(chalk.cyan(`  ⬇ Pulled latest from origin/${state.detectedBaseBranch}`));
            }
          } else {
            const errMsg = mergeResult.stderr?.trim() || 'fast-forward not possible';

            if (state.pullPolicy === 'halt') {
              console.log();
              console.log(chalk.red(`✗ HCF — Base branch has diverged from origin/${state.detectedBaseBranch}`));
              console.log(chalk.gray(`  ${errMsg}`));
              console.log();
              console.log(chalk.bold('Resolution:'));
              console.log(`  1. Resolve the divergence (rebase, merge, or reset)`);
              console.log(`  2. Re-run: promptwheel`);
              console.log();
              console.log(chalk.gray(`  To keep going despite divergence, set pullPolicy: "warn" in config.`));

              // Signal orchestrator to break — finalizeSession handles cleanup
              state.shutdownRequested = true;
              if (state.shutdownReason === null) state.shutdownReason = 'branch_diverged';
              return { shouldSkipCycle: true };
            } else {
              console.log(chalk.yellow(`  ⚠ Base branch diverged from origin/${state.detectedBaseBranch} — continuing on stale base`));
              console.log(chalk.gray(`    ${errMsg}`));
              console.log(chalk.gray(`    Subsequent work may produce merge conflicts`));
            }
          }
        } else if (state.options.verbose) {
          console.log(chalk.yellow(`  ⚠ Fetch failed (network?): ${fetchResult.stderr?.trim()}`));
        }
      } catch {
        // Network unavailable — non-fatal
      }
    }
  }

  // Periodic PR status poll (every 5 cycles)
  if (state.runMode === 'spin' && state.cycleCount > 1 && state.cycleCount % 5 === 0 && state.pendingPrUrls.length > 0) {
    try {
      const prStatuses = await checkPrStatuses(state.repoRoot, state.pendingPrUrls);
      for (const pr of prStatuses) {
        if (pr.state === 'merged') {
          state.totalMergedPrs++;
          const prMeta = state.prMetaMap.get(pr.url);
          if (prMeta) {
            if (state.sectorState) recordMergeOutcome(state.sectorState, prMeta.sectorId, true);
            recordFormulaMergeOutcome(state.repoRoot, prMeta.formula, true);
          }
          try { updatePrOutcome(state.repoRoot, pr.url, 'merged', Date.now()); } catch { /* non-fatal */ }
          if (state.autoConf.learningsEnabled) {
            addLearning(state.repoRoot, {
              text: `PR merged: ${pr.url}`.slice(0, 200),
              category: 'pattern',
              source: { type: 'ticket_success', detail: 'pr_merged' },
              tags: [],
            });
          }
          // Clean up merged branch (local + remote)
          if (pr.branch) {
            await deleteTicketBranch(state.repoRoot, pr.branch).catch(() => {});
            await deleteRemoteBranch(state.repoRoot, pr.branch).catch(() => {});
          }
        } else if (pr.state === 'closed') {
          state.totalClosedPrs++;
          const prMeta = state.prMetaMap.get(pr.url);
          if (prMeta) {
            if (state.sectorState) recordMergeOutcome(state.sectorState, prMeta.sectorId, false);
            recordFormulaMergeOutcome(state.repoRoot, prMeta.formula, false);
          }
          try { updatePrOutcome(state.repoRoot, pr.url, 'closed', Date.now()); } catch { /* non-fatal */ }
          if (state.autoConf.learningsEnabled) {
            addLearning(state.repoRoot, {
              text: `PR closed/rejected: ${pr.url}`.slice(0, 200),
              category: 'warning',
              source: { type: 'ticket_failure', detail: 'pr_closed' },
              tags: [],
            });
            const comments = await fetchPrReviewComments(state.repoRoot, pr.url);
            if (comments.length > 0) {
              const substantive = comments.sort((a, b) => b.body.length - a.body.length)[0];
              addLearning(state.repoRoot, {
                text: `PR rejected: ${substantive.body}`.slice(0, 200),
                category: 'warning',
                source: { type: 'reviewer_feedback', detail: substantive.author },
                tags: [],
              });
            }
          }
        }
      }
      const closedOrMergedUrls = prStatuses
        .filter(p => p.state === 'merged' || p.state === 'closed')
        .map(p => p.url);
      if (closedOrMergedUrls.length > 0) {
        removePrEntries(state.repoRoot, closedOrMergedUrls);
      }
      const closedOrMergedSet = new Set(closedOrMergedUrls);
      state.pendingPrUrls = state.pendingPrUrls.filter(u => !closedOrMergedSet.has(u));
    } catch {
      // Non-fatal
    }
  }

  // Periodic guidelines refresh
  if (state.guidelinesRefreshInterval > 0 && state.cycleCount > 1 && state.cycleCount % state.guidelinesRefreshInterval === 0) {
    try {
      state.guidelines = loadGuidelines(state.repoRoot, state.guidelinesOpts);
      if (state.guidelines && state.options.verbose) {
        console.log(chalk.gray(`  Refreshed project guidelines (${state.guidelines.source})`));
      }
    } catch {
      // Non-fatal — keep existing guidelines
    }
  }

  return { shouldSkipCycle: false };
}

// ── Post-cycle maintenance ──────────────────────────────────────────────────

export async function runPostCycleMaintenance(state: AutoSessionState, scope: string, isDocsAuditCycle: boolean): Promise<void> {
  state.currentlyProcessing = false;

  // Save sector outcome stats
  if (state.sectorState) saveSectors(state.repoRoot, state.sectorState);

  // Record cycle completion
  const updatedRunState = recordCycle(state.repoRoot);
  if (isDocsAuditCycle) {
    recordDocsAudit(state.repoRoot);
  }

  // Record cycle summary
  {
    const cycleSummary: CycleSummary = {
      cycle: updatedRunState.totalCycles,
      scope: scope,
      formula: state.currentFormulaName,
      succeeded: state.cycleOutcomes
        .filter(o => o.status === 'completed')
        .map(o => ({ title: o.title, category: o.category || 'unknown' })),
      failed: state.cycleOutcomes
        .filter(o => o.status === 'failed')
        .map(o => ({ title: o.title, reason: 'agent_error' })),
      noChanges: state.cycleOutcomes
        .filter(o => o.status === 'no_changes')
        .map(o => o.title),
    };
    const rs = readRunState(state.repoRoot);
    rs.recentCycles = pushCycleSummary(rs.recentCycles ?? [], cycleSummary);
    writeRunState(state.repoRoot, rs);
  }

  // Baseline healing check: re-run failing commands to detect improvements
  const completedThisCycle = state.cycleOutcomes.filter(o => o.status === 'completed').length;
  if (completedThisCycle > 0 && state.config?.qa?.commands?.length) {
    try {
      const blPath = path.join(getPromptwheelDir(state.repoRoot), 'qa-baseline.json');
      if (fs.existsSync(blPath)) {
        const blData = JSON.parse(fs.readFileSync(blPath, 'utf8'));
        const previouslyFailing: string[] = blData.failures ?? [];
        if (previouslyFailing.length > 0 && previouslyFailing.length <= 5) {
          // Only re-check the previously failing commands (not all)
          const qaConfig = normalizeQaConfig(state.config);
          const failingCmds = qaConfig.commands.filter(c => previouslyFailing.includes(c.name));
          if (failingCmds.length > 0) {
            const checkConfig = { ...state.config, qa: { ...state.config.qa, commands: failingCmds } };
            const recheck = await captureQaBaseline(state.repoRoot, checkConfig, () => {}, state.repoRoot);
            const healed: string[] = [];
            const stillFailing: string[] = [];
            for (const [name, result] of recheck) {
              if (result.passed) {
                healed.push(name);
              } else {
                stillFailing.push(name);
              }
            }
            if (healed.length > 0) {
              console.log(chalk.green(`  Baseline healed: ${healed.join(', ')} now passing`));
              if (state.autoConf.learningsEnabled) {
                addLearning(state.repoRoot, {
                  text: `Baseline healed in ${scope}: ${healed.join(', ')} now pass after cycle ${state.cycleCount}`.slice(0, 200),
                  category: 'pattern',
                  source: { type: 'baseline_healed', detail: healed.join(', ') },
                  tags: extractTags([scope], []),
                });
              }
              // Update qa-baseline.json with only still-failing commands
              const updatedDetails: Record<string, any> = {};
              for (const name of stillFailing) {
                updatedDetails[name] = (blData.details ?? {})[name] ?? { cmd: name, output: '' };
                // Refresh output from recheck
                const recheckResult = recheck.get(name);
                if (recheckResult?.output) updatedDetails[name].output = recheckResult.output;
              }
              const blTmp = blPath + '.tmp';
              fs.writeFileSync(blTmp, JSON.stringify({
                failures: stillFailing,
                details: updatedDetails,
                timestamp: Date.now(),
              }));
              fs.renameSync(blTmp, blPath);
            }
          }
        }
      }
    } catch (err) {
      console.warn(chalk.gray(`  Baseline healing skipped: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Meta-learning extraction (aggregate pattern detection)
  let metaInsightsAdded = 0;
  if (state.autoConf.learningsEnabled && state.cycleCount >= 3) {
    try {
      metaInsightsAdded = extractMetaLearnings({
        projectRoot: state.repoRoot,
        cycleOutcomes: state.cycleOutcomes,
        allOutcomes: state.allTicketOutcomes,
        learningsEnabled: state.autoConf.learningsEnabled,
        existingLearnings: state.allLearnings,
      });
      if (metaInsightsAdded > 0 && state.options.verbose) {
        console.log(chalk.gray(`  Meta-learnings: ${metaInsightsAdded} process insight(s) extracted`));
      }
    } catch {
      // Non-fatal
    }
  }

  // Low-yield cycle detection — primary Nash equilibrium stop signal
  const completedThisCount = state.cycleOutcomes.filter(o => o.status === 'completed').length;
  if (completedThisCount === 0 && state.cycleCount >= 2) {
    state.consecutiveLowYieldCycles++;
    const MAX_LOW_YIELD_CYCLES = state.drillMode ? 5 : 3;
    if (state.consecutiveLowYieldCycles >= MAX_LOW_YIELD_CYCLES) {
      console.log(chalk.yellow(`  ${state.consecutiveLowYieldCycles} consecutive low-yield cycles — diminishing returns, stopping`));
      state.shutdownRequested = true;
      if (state.shutdownReason === null) state.shutdownReason = 'low_yield';
    } else if (state.options.verbose) {
      console.log(chalk.gray(`  Low-yield cycle (${state.consecutiveLowYieldCycles}/${MAX_LOW_YIELD_CYCLES})`));
    }
  } else if (completedThisCount > 0) {
    state.consecutiveLowYieldCycles = 0;
  }

  // Wheel diagnostics one-liner (always shown, not verbose-gated)
  if (state.cycleCount >= 2) {
    const qualityRate = getQualityRate(state.repoRoot);
    const qualityPct = Math.round(qualityRate * 100);
    const { loadQaStats: loadQa } = await import('./qa-stats.js');
    loadQa(state.repoRoot);
    const baselineFailing = state.qaBaseline
      ? [...state.qaBaseline.values()].filter(v => !v).length
      : 0;
    const confValue = state.effectiveMinConfidence;
    const insightsStr = metaInsightsAdded > 0 ? ` | insights +${metaInsightsAdded}` : '';
    const baselineStr = baselineFailing > 0 ? ` | baseline failing ${baselineFailing}` : '';
    console.log(chalk.gray(`  Spin: quality ${qualityPct}% | confidence ${confValue}${baselineStr}${insightsStr}`));
  }

  // Convergence metrics
  if (state.cycleCount >= 3 && state.sectorState) {
    const rs = readRunState(state.repoRoot);
    const sessionCtx = {
      elapsedMs: Date.now() - state.startTime,
      prsCreated: state.allPrUrls.length,
      prsMerged: state.totalMergedPrs,
      prsClosed: state.totalClosedPrs,
    };
    // Build drill context for convergence if in drill mode
    let drillCtx: Parameters<typeof computeConvergenceMetrics>[4] | undefined;
    if (state.drillMode && state.drillHistory.length >= 2) {
      const { computeDrillMetrics } = await import('./solo-auto-drill.js');
      const dm = computeDrillMetrics(state.drillHistory);
      drillCtx = {
        completionRate: dm.completionRate,
        step1FailureRate: dm.step1FailureRate,
        consecutiveInsufficient: state.drillConsecutiveInsufficient,
        trajectoryCount: dm.totalTrajectories,
      };
    }
    const metrics = computeConvergenceMetrics(state.sectorState, state.allLearnings.length, rs.recentCycles ?? [], sessionCtx, drillCtx);
    console.log(chalk.gray(`  ${formatConvergenceOneLiner(metrics)}`));
    if (metrics.suggestedAction === 'stop') {
      if (state.activeTrajectory && state.activeTrajectoryState) {
        // Adaptive threshold: use historical completion rate to decide when to abandon
        // If we historically complete 80% of trajectories, a low-progress one is likely still worth finishing
        // If we historically complete 20%, cut losses earlier
        let abandonThreshold = 50; // default: stop if < 50% complete
        if (state.drillMode && state.drillHistory.length >= 3) {
          const { computeDrillMetrics: cdm } = await import('./solo-auto-drill.js');
          const dm = cdm(state.drillHistory);
          // Higher historical completion → higher threshold (more patience)
          // Lower historical completion → lower threshold (cut losses faster)
          abandonThreshold = Math.round(30 + (dm.weightedCompletionRate * 40)); // range: 30-70%
        }
        const totalSteps = state.activeTrajectory.steps.length;
        const completedSteps = state.activeTrajectory.steps.filter(
          s => state.activeTrajectoryState!.stepStates[s.id]?.status === 'completed',
        ).length;
        const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
        if (progressPct < abandonThreshold) {
          console.log(chalk.yellow(`  Convergence suggests stopping — trajectory "${state.activeTrajectory.name}" only ${progressPct}% complete, skipping it`));
          if (state.drillMode) {
            try { finishDrillTrajectory(state, 'stalled'); }
            catch (err) { console.log(chalk.yellow(`  Drill: failed to record trajectory outcome — ${err instanceof Error ? err.message : String(err)}`)); }
          }
          state.activeTrajectory = null;
          state.activeTrajectoryState = null;
          state.currentTrajectoryStep = null;
          state.shutdownRequested = true;
          if (state.shutdownReason === null) state.shutdownReason = 'convergence';
        } else {
          console.log(chalk.gray(`  Convergence suggests stopping, but trajectory "${state.activeTrajectory.name}" is ${progressPct}% complete — continuing`));
        }
      } else {
        console.log(chalk.yellow(`  Convergence suggests stopping — most sectors polished, low yield.`));
        state.shutdownRequested = true;
        if (state.shutdownReason === null) state.shutdownReason = 'convergence';
      }
    }
  }

  // Scope adjustment (confidence only — impact uses static config floor)
  if (state.sectorState && state.cycleCount >= 3) {
    const scopeAdj = suggestScopeAdjustment(state.sectorState);
    if (scopeAdj === 'widen') {
      // In drill mode with active trajectory, don't widen — stay focused on trajectory scope
      if (state.drillMode && state.currentTrajectoryStep?.scope) {
        if (state.options.verbose) console.log(chalk.gray(`  Scope adjustment: drill mode — staying focused on trajectory scope`));
      } else {
        state.effectiveMinConfidence = state.autoConf.minConfidence ?? 20;
        if (state.options.verbose) console.log(chalk.gray(`  Scope adjustment: widening (resetting confidence threshold)`));
      }
    } else if (scopeAdj === 'narrow' && state.drillMode && state.currentTrajectoryStep) {
      // In drill mode, tighten confidence when trajectory-guided to focus on high-quality proposals
      state.effectiveMinConfidence += 5;
      if (state.options.verbose) console.log(chalk.gray(`  Scope adjustment: drill-narrowed (confidence +5)`));
    }
  }

  // Cross-sector pattern learning
  if (state.sectorState && state.currentSectorId && state.autoConf.learningsEnabled) {
    const sec = state.sectorState.sectors.find(s => s.path === state.currentSectorId);
    if (sec?.categoryStats) {
      for (const [cat, stats] of Object.entries(sec.categoryStats)) {
        if (stats.success >= 3) {
          const otherUnscanned = state.sectorState.sectors.filter(
            s => s.path !== state.currentSectorId && s.production && s.scanCount === 0
          );
          if (otherUnscanned.length > 0) {
            addLearning(state.repoRoot, {
              text: `Pattern from ${state.currentSectorId}: ${cat} proposals succeed well. Consider similar work in other sectors.`.slice(0, 200),
              category: 'pattern',
              source: { type: 'cross_sector_pattern' },
              tags: [cat],
            });
          }
        }
      }
    }
  }

  // Learning ROI snapshot (every 10 cycles)
  if (state.cycleCount % 10 === 0 && state.autoConf.learningsEnabled) {
    try {
      const { getLearningEffectiveness } = await import('./learnings.js');
      snapshotLearningROI(state.repoRoot, getLearningEffectiveness);
    } catch { /* non-fatal */ }
  }

  // Periodic learnings consolidation
  try {
    if (state.cycleCount % 5 === 0 && state.autoConf.learningsEnabled) {
      consolidateLearnings(state.repoRoot);
      state.allLearnings = loadLearnings(state.repoRoot, 0);
    }

    if (state.autoConf.learningsEnabled && state.cycleCount % 5 !== 0) {
      state.allLearnings = loadLearnings(state.repoRoot, 0);
      if (state.allLearnings.length > 50) {
        consolidateLearnings(state.repoRoot);
        state.allLearnings = loadLearnings(state.repoRoot, 0);
      }
    }
  } catch (err) {
    // Non-fatal — learnings persist from previous cycle
    console.warn(chalk.gray(`  Learnings consolidation skipped: ${err instanceof Error ? err.message : String(err)}`));
  }

  // Refresh codebase index
  if (state.codebaseIndex && hasStructuralChanges(state.codebaseIndex, state.repoRoot)) {
    try {
      state.codebaseIndex = refreshCodebaseIndex(state.codebaseIndex, state.repoRoot, state.excludeDirs);
      if (state.options.verbose) {
        console.log(chalk.gray(`  Codebase index refreshed: ${state.codebaseIndex.modules.length} modules`));
      }
      if (state.sectorState) {
        state.sectorState = refreshSectors(
          state.repoRoot,
          state.sectorState,
          state.codebaseIndex.modules,
        );
        if (state.options.verbose) {
          console.log(chalk.gray(`  Sectors refreshed: ${state.sectorState.sectors.length} sector(s)`));
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // Reload dedup memory
  if (state.runMode === 'spin') {
    state.dedupMemory = loadDedupMemory(state.repoRoot);
  }

  // Goal re-measurement
  if (state.activeGoal?.measure && state.activeGoalMeasurement) {
    const { value, error } = runMeasurement(state.activeGoal.measure.cmd, state.repoRoot);
    if (value !== null) {
      const prev = state.activeGoalMeasurement.current;
      const delta = prev !== null ? value - prev : 0;
      const deltaSign = delta > 0 ? '+' : '';
      const arrow = state.activeGoal.measure.direction === 'up'
        ? (delta > 0 ? chalk.green('↑') : delta < 0 ? chalk.yellow('↓') : '→')
        : (delta < 0 ? chalk.green('↓') : delta > 0 ? chalk.yellow('↑') : '→');
      console.log(chalk.cyan(`  🎯 ${state.activeGoal.name}: ${value} ${arrow} (${deltaSign}${delta.toFixed(1)}) target: ${state.activeGoal.measure.target}`));

      // Check if goal is now met
      const { target, direction } = state.activeGoal.measure;
      const met = direction === 'up' ? value >= target : value <= target;

      // Record measurement
      const measurement = { ...state.activeGoalMeasurement, current: value, measuredAt: Date.now(), met };
      recordGoalMeasurement(state.repoRoot, measurement);

      if (met) {
        console.log(chalk.green(`  ✓ Goal "${state.activeGoal.name}" met!`));

        // Re-evaluate all goals and pivot to next
        const allMeasurements = measureGoals(state.goals, state.repoRoot);
        for (const m of allMeasurements) {
          recordGoalMeasurement(state.repoRoot, m);
        }
        const next = pickGoalByGap(allMeasurements);
        if (next) {
          state.activeGoal = state.goals.find(g => g.name === next.goalName) ?? null;
          state.activeGoalMeasurement = next;
          console.log(chalk.cyan(`  → Pivoting to: ${next.goalName} (gap: ${next.gapPercent}%)`));
        } else {
          const allMet = allMeasurements.every(m => m.met);
          if (allMet) {
            console.log(chalk.green(`  ✓ All goals met!`));
          }
          state.activeGoal = null;
          state.activeGoalMeasurement = null;
        }
      } else {
        // Update current value for next cycle's prompt
        state.activeGoalMeasurement.current = value;
        // Recalculate gap (guarded against division by zero)
        if (direction === 'up') {
          if (value >= target) {
            state.activeGoalMeasurement.gapPercent = 0;
          } else if (target !== 0) {
            state.activeGoalMeasurement.gapPercent = Math.round(((target - value) / target) * 1000) / 10;
          } else {
            state.activeGoalMeasurement.gapPercent = 100;
          }
        } else if (direction === 'down') {
          if (value <= target) {
            state.activeGoalMeasurement.gapPercent = 0;
          } else if (value !== 0) {
            state.activeGoalMeasurement.gapPercent = Math.round(((value - target) / value) * 1000) / 10;
          } else {
            state.activeGoalMeasurement.gapPercent = 0;
          }
        }
      }
    } else {
      console.log(chalk.yellow(`  ⚠ Goal "${state.activeGoal.name}" re-measurement failed${error ? `: ${error}` : ''}`));
    }
  }

  // Trajectory cycle budget — abandon if consuming too many cycles.
  // Scales with step count: more steps get more budget (2-step → base, 8-step → ~2x base).
  if (state.drillMode && state.activeTrajectory && state.activeTrajectoryState) {
    const baseMaxCycles = state.autoConf.drill?.maxCyclesPerTrajectory ?? 15;
    const stepsTotal = state.activeTrajectory.steps.length;
    const maxCycles = Math.round(baseMaxCycles * Math.min(2.5, Math.max(0.8, 1 + Math.max(0, stepsTotal - 3) / 5)));
    const totalCyclesUsed = Object.values(state.activeTrajectoryState.stepStates)
      .reduce((sum, s) => sum + (s.cyclesAttempted ?? 0), 0);
    if (totalCyclesUsed >= maxCycles) {
      const completedSteps = state.activeTrajectory.steps.filter(
        s => state.activeTrajectoryState!.stepStates[s.id]?.status === 'completed',
      ).length;
      const pct = Math.round((completedSteps / state.activeTrajectory.steps.length) * 100);
      console.log(chalk.yellow(`  Drill: trajectory "${state.activeTrajectory.name}" hit cycle budget (${totalCyclesUsed}/${maxCycles} cycles, ${pct}% complete) — abandoning`));
      saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
      try { finishDrillTrajectory(state, 'stalled'); }
      catch (err) { console.log(chalk.yellow(`  Drill: failed to record trajectory outcome — ${err instanceof Error ? err.message : String(err)}`)); }
      state.activeTrajectory = null;
      state.activeTrajectoryState = null;
      state.currentTrajectoryStep = null;
    }
  }

  // Trajectory step progression
  if (state.activeTrajectory && state.activeTrajectoryState && state.currentTrajectoryStep) {
    const step = state.currentTrajectoryStep;
    const stepState = state.activeTrajectoryState.stepStates[step.id];

    if (stepState) {
      // Run step verification commands
      let allPassed = true;
      const verificationOutputParts: string[] = [];
      if (step.verification_commands.length > 0) {
        for (const cmd of step.verification_commands) {
          const result = spawnSync('sh', ['-c', cmd], {
            cwd: state.repoRoot,
            timeout: 30000,
            encoding: 'utf-8',
          });
          if (result.error) {
            // Timeout or spawn error
            allPassed = false;
            const reason = result.error.message?.includes('TIMEOUT') ? 'timeout (30s)' : result.error.message;
            console.log(chalk.yellow(`    ✗ ${cmd} (${reason})`));
            verificationOutputParts.push(`$ ${cmd}\n${reason}`);
          } else if (result.status !== 0) {
            allPassed = false;
            const stderr = (result.stderr || '').trim().slice(0, 500);
            const stdout = (result.stdout || '').trim().slice(0, 200);
            console.log(chalk.yellow(`    ✗ ${cmd} (exit ${result.status})`));
            if (stderr) console.log(chalk.gray(`      ${stderr.split('\n')[0]}`));
            else if (stdout) console.log(chalk.gray(`      ${stdout.split('\n')[0]}`));
            verificationOutputParts.push(`$ ${cmd} (exit ${result.status})\n${stderr || stdout}`);
          }
        }
      }

      // Optional measurement check
      let measureMet = true;
      if (step.measure) {
        const { value, error } = runMeasurement(step.measure.cmd, state.repoRoot);
        if (value !== null) {
          const arrow = step.measure.direction === 'up' ? '>=' : '<=';
          measureMet = step.measure.direction === 'up'
            ? value >= step.measure.target
            : value <= step.measure.target;
          stepState.measurement = { value, timestamp: Date.now() };
          if (!measureMet) {
            console.log(chalk.yellow(`    measure: ${value} (target: ${arrow} ${step.measure.target})`));
          }
        } else {
          measureMet = false;
          console.log(chalk.yellow(`    measure failed${error ? `: ${error}` : ''}`));
        }
      }

      if (allPassed && measureMet) {
        // Step completed — advance
        stepState.status = 'completed';
        stepState.completedAt = Date.now();
        stepState.consecutiveFailures = 0;
        stepState.lastVerificationOutput = undefined;
        const completedCount = state.activeTrajectory.steps.filter(s => state.activeTrajectoryState!.stepStates[s.id]?.status === 'completed').length;
        const totalCount = state.activeTrajectory.steps.length;
        console.log(chalk.green(`  Trajectory step ${completedCount}/${totalCount} "${step.title}" completed`));

        // Pick next step
        const next = getTrajectoryNextStep(state.activeTrajectory, state.activeTrajectoryState.stepStates);
        state.currentTrajectoryStep = next;
        if (next) {
          state.activeTrajectoryState.currentStepId = next.id;
          if (state.activeTrajectoryState.stepStates[next.id]) {
            state.activeTrajectoryState.stepStates[next.id].status = 'active';
          }
          console.log(chalk.cyan(`  -> Next step: ${next.title}`));
        } else if (trajectoryComplete(state.activeTrajectory, state.activeTrajectoryState.stepStates)) {
          const fullySucceeded = trajectoryFullySucceeded(state.activeTrajectory, state.activeTrajectoryState.stepStates);
          const outcome = fullySucceeded ? 'completed' : 'stalled';
          if (fullySucceeded) {
            console.log(chalk.green(`  Trajectory "${state.activeTrajectory.name}" complete!`));
          } else {
            console.log(chalk.yellow(`  Trajectory "${state.activeTrajectory.name}" finished with some failed steps`));
          }
          // Save final state before clearing (so completed status persists on disk)
          saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
          if (state.drillMode) {
            try { finishDrillTrajectory(state, outcome); }
            catch (err) { console.log(chalk.yellow(`  Drill: failed to record trajectory outcome — ${err instanceof Error ? err.message : String(err)}`)); }
          }
          state.activeTrajectory = null;
          state.activeTrajectoryState = null;
          state.currentTrajectoryStep = null;
        } else {
          // No next step available but trajectory isn't complete — shouldn't happen now
          // (failed deps unblock dependents), but handle as fallback
          console.log(chalk.yellow(`  Trajectory "${state.activeTrajectory.name}" stalled (remaining steps blocked)`));
          saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
          if (state.drillMode) {
            try { finishDrillTrajectory(state, 'stalled'); }
            catch (err) { console.log(chalk.yellow(`  Drill: failed to record trajectory outcome — ${err instanceof Error ? err.message : String(err)}`)); }
          }
          state.activeTrajectory = null;
          state.activeTrajectoryState = null;
          state.currentTrajectoryStep = null;
        }
      } else {
        // Step not yet complete — increment attempt counter
        stepState.cyclesAttempted++;
        stepState.lastAttemptedCycle = state.cycleCount;
        // Track consecutive and total failures for transient/flakiness detection
        stepState.consecutiveFailures = (stepState.consecutiveFailures ?? 0) + 1;
        stepState.totalFailures = (stepState.totalFailures ?? 0) + 1;
        // Capture verification output for prompt injection on next attempt
        if (verificationOutputParts.length > 0) {
          stepState.lastVerificationOutput = verificationOutputParts.join('\n').slice(0, 1000);
        }

        // Check for stuck — pass full step list so each step uses its own max_retries
        const stuckId = trajectoryStuck(state.activeTrajectoryState.stepStates, undefined, state.activeTrajectory.steps);
        if (stuckId) {
          // Fail the actual stuck step (may differ from current step if state was corrupted)
          const stuckStepState = state.activeTrajectoryState.stepStates[stuckId];
          const stuckStep = state.activeTrajectory.steps.find(s => s.id === stuckId);
          const stuckTitle = stuckStep?.title ?? stuckId;
          const stuckAttempts = stuckStepState?.cyclesAttempted ?? stepState.cyclesAttempted;
          console.log(chalk.yellow(`  Trajectory step "${stuckTitle}" stuck after ${stuckAttempts} cycles`));
          if (stuckStepState) {
            stuckStepState.status = 'failed';
            stuckStepState.failureReason = 'max retries exceeded';
          }

          // Try to advance to next step
          const next = getTrajectoryNextStep(state.activeTrajectory, state.activeTrajectoryState.stepStates);
          state.currentTrajectoryStep = next;
          if (next) {
            state.activeTrajectoryState.currentStepId = next.id;
            if (state.activeTrajectoryState.stepStates[next.id]) {
              state.activeTrajectoryState.stepStates[next.id].status = 'active';
            }
            console.log(chalk.cyan(`  -> Skipping to next step: ${next.title}`));
          } else {
            // No more steps — trajectory is done (all remaining steps failed or completed)
            console.log(chalk.yellow(`  Trajectory "${state.activeTrajectory.name}" ended (no remaining steps)`));
            saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
            if (state.drillMode) {
              try { finishDrillTrajectory(state, 'stalled'); }
              catch (err) { console.log(chalk.yellow(`  Drill: failed to record trajectory outcome — ${err instanceof Error ? err.message : String(err)}`)); }
            }
            state.activeTrajectory = null;
            state.activeTrajectoryState = null;
            state.currentTrajectoryStep = null;
          }
        }
      }

      if (state.activeTrajectoryState) {
        saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
      }
    }
  }

  // Pause between cycles — shorter when trajectory-guided (work is pre-planned)
  if (state.runMode === 'spin' && !state.shutdownRequested) {
    const pauseMs = state.currentTrajectoryStep ? 1000 : 5000;
    console.log(chalk.gray('Pausing before next cycle...'));
    await sleep(pauseMs);
  }
}

// ── Drill trajectory lifecycle ───────────────────────────────────────────────

/**
 * Record a drill trajectory's completion/stall into history, record learnings,
 * and log the next-survey message.
 *
 * Must be called BEFORE clearing state.activeTrajectory (needs the trajectory data).
 */
function finishDrillTrajectory(state: AutoSessionState, outcome: 'completed' | 'stalled'): void {
  if (!state.activeTrajectory || !state.activeTrajectoryState) return;
  const traj = state.activeTrajectory;
  const trajState = state.activeTrajectoryState;

  const stepsTotal = traj.steps.length;
  const stepsCompleted = traj.steps.filter(s => trajState.stepStates[s.id]?.status === 'completed').length;
  const stepsFailed = traj.steps.filter(s => trajState.stepStates[s.id]?.status === 'failed').length;

  // Collect failed step details for history
  const failedStepDetails = traj.steps
    .filter(s => trajState.stepStates[s.id]?.status === 'failed')
    .map(s => ({
      id: s.id,
      title: s.title,
      reason: trajState.stepStates[s.id]?.lastVerificationOutput?.slice(0, 200)
        ?? trajState.stepStates[s.id]?.failureReason,
    }));

  // Collect completed step summaries for causal chaining
  const completedStepSummaries = traj.steps
    .filter(s => trajState.stepStates[s.id]?.status === 'completed')
    .map(s => s.title);

  // Collect modified files from git (since trajectory started)
  let modifiedFiles: string[] | undefined;
  try {
    const trajStartTime = trajState.startedAt ?? (state.startTime || 0);
    if (trajStartTime > 0) {
      // Use git log --diff-filter with --since instead of HEAD~N (which fails with shallow repos or few commits)
      const sinceDate = new Date(trajStartTime).toISOString();
      const gitResult = spawnSync('git', [
        'log', '--diff-filter=ACMR', '--name-only', '--pretty=format:',
        `--since=${sinceDate}`,
      ], { cwd: state.repoRoot, encoding: 'utf-8', timeout: 5000 });
      if (!gitResult.error && gitResult.status === 0 && gitResult.stdout.trim()) {
        // Deduplicate file names (same file may appear in multiple commits)
        modifiedFiles = [...new Set(gitResult.stdout.trim().split('\n').filter(Boolean))].slice(0, 20);
      }
    }
  } catch { /* non-fatal */ }

  // Collect per-step outcomes for telemetry (enables step-level learning)
  const stepOutcomes = traj.steps.map(s => ({
    id: s.id,
    status: (trajState.stepStates[s.id]?.status ?? 'pending') as 'completed' | 'failed' | 'skipped' | 'pending',
  }));

  // Record into drill history (for avoidance + diversity + stats)
  recordDrillTrajectoryOutcome(
    state,
    traj.name,
    traj.description,
    stepsTotal,
    stepsCompleted,
    stepsFailed,
    outcome,
    traj.steps,
    failedStepDetails.length > 0 ? failedStepDetails : undefined,
    completedStepSummaries.length > 0 ? completedStepSummaries : undefined,
    modifiedFiles,
    computeAmbitionLevel(state),
    {
      stepOutcomes,
      ...state.drillGenerationTelemetry,
    },
  );
  state.drillGenerationTelemetry = null;

  // Record learnings
  if (state.autoConf.learningsEnabled) {
    const categories = [...new Set(traj.steps.flatMap(s => s.categories ?? []))];
    const catLabel = categories.join(', ') || 'mixed';

    if (outcome === 'completed') {
      addLearning(state.repoRoot, {
        text: `Drill trajectory "${traj.name}" completed (${stepsCompleted}/${stepsTotal} steps). Theme: ${traj.description}. Categories: ${catLabel}`.slice(0, 200),
        category: 'pattern',
        source: { type: 'drill_completed', detail: traj.name },
        tags: categories,
      });
    } else {
      const failedSteps = traj.steps
        .filter(s => trajState.stepStates[s.id]?.status === 'failed')
        .map(s => s.title);
      addLearning(state.repoRoot, {
        text: `Drill trajectory "${traj.name}" stalled (${stepsCompleted}/${stepsTotal} completed, ${stepsFailed} failed). Failed: ${failedSteps.join(', ')}`.slice(0, 200),
        category: 'warning',
        source: { type: 'drill_stalled', detail: traj.name },
        tags: categories,
      });
    }
  }

  const rate = stepsTotal > 0 ? Math.round((stepsCompleted / stepsTotal) * 100) : 0;
  console.log(chalk.cyan(`  Drill: trajectory ${outcome} (${stepsCompleted}/${stepsTotal} steps, ${rate}% completion)`));
  console.log(chalk.cyan('  Drill: will survey for next trajectory on next cycle'));

  // Notify display adapter that trajectory finished (back to idle)
  state.displayAdapter.drillStateChanged({ active: true });

  // Reload learnings immediately so next trajectory generation has fresh context
  if (state.autoConf.learningsEnabled) {
    try {
      state.allLearnings = loadLearnings(state.repoRoot, 0);
    } catch { /* non-fatal */ }
  }
}
