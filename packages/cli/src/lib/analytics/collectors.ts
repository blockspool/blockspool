import { analyzeErrorLedger } from '../error-ledger.js';
import type { MetricsSummary } from '../metrics.js';
import { analyzePrOutcomes } from '../pr-outcomes.js';
import type { RunHistoryEntry } from '../run-history.js';
import { readRunState } from '../run-state.js';
import { analyzeSpindleIncidents } from '../spindle-incidents.js';
import { loadTrajectoryState, loadTrajectories } from '../trajectory.js';

export interface LearningStats {
  total: number;
  applied: number;
  successRate: number;
  topPerformers: Array<{ id: string; text: string; effectiveness: number }>;
}

export type CompactAnalyticsSection = 'working' | 'attention' | 'recommendations';

export interface CompactAnalyticsInsight {
  section: CompactAnalyticsSection;
  message: string;
}

export interface CompactAnalyticsCollectorContext {
  summary: MetricsSummary;
  history: RunHistoryEntry[];
  learningStats: LearningStats;
  repoRoot: string;
  nowMs?: number;
}

export interface CompactAnalyticsBuckets {
  working: string[];
  attention: string[];
  recommendations: string[];
}

type Collector = (context: CompactAnalyticsCollectorContext) => CompactAnalyticsInsight[];

interface CollectorRegistration {
  collect: Collector;
  failSoft?: boolean;
}

const COLLECTORS: CollectorRegistration[] = [
  { collect: collectLearningInsights },
  { collect: collectDedupInsights },
  { collect: collectSpindleSystemInsights },
  { collect: collectSectorsInsights },
  { collect: collectWaveInsights },
  { collect: collectSessionSuccessInsights },
  { collect: collectTimingInsights },
  { collect: collectCategoryPerformanceInsights, failSoft: true },
  { collect: collectPrOutcomesInsights, failSoft: true },
  { collect: collectErrorPatternInsights, failSoft: true },
  { collect: collectCostInsights },
  { collect: collectLearningRoiInsights, failSoft: true },
  { collect: collectSpindleIncidentInsights, failSoft: true },
  { collect: collectShutdownReasonInsights },
  { collect: collectDrillPerformanceInsights },
  { collect: collectTrajectoryProgressInsights, failSoft: true },
];

export function collectCompactAnalyticsInsights(context: CompactAnalyticsCollectorContext): CompactAnalyticsInsight[] {
  const insights: CompactAnalyticsInsight[] = [];

  for (const collector of COLLECTORS) {
    if (collector.failSoft) {
      try {
        insights.push(...collector.collect(context));
      } catch {
        // Non-fatal source: keep analytics output available even if one source fails.
      }
      continue;
    }

    insights.push(...collector.collect(context));
  }

  return insights;
}

export function classifyCompactAnalyticsInsights(insights: CompactAnalyticsInsight[]): CompactAnalyticsBuckets {
  const buckets: CompactAnalyticsBuckets = {
    working: [],
    attention: [],
    recommendations: [],
  };

  for (const insight of insights) {
    buckets[insight.section].push(insight.message);
  }

  return buckets;
}

export function collectLearningInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const insights: CompactAnalyticsInsight[] = [];
  const learnings = context.summary.bySystem['learnings'];

  if (learnings || context.learningStats.total > 0) {
    const selected = learnings?.events['selected'] || 0;
    const applied = context.learningStats.applied;
    const effectivenessStr = context.learningStats.applied > 0
      ? `, ${Math.round(context.learningStats.successRate * 100)}% effective`
      : '';

    if (applied > 0) {
      insights.push(working(`Learnings: ${applied} applied${effectivenessStr}`));
      if (context.learningStats.successRate < 0.5 && context.learningStats.applied >= 5) {
        insights.push(attention('Learnings effectiveness below 50%'));
        insights.push(recommendation('Review learnings with `promptwheel analytics --verbose`'));
      }
    } else if (selected > 0) {
      insights.push(working(`Learnings: ${selected} selected for context`));
    } else if (context.learningStats.total > 0) {
      insights.push(attention(`Learnings: ${context.learningStats.total} stored but none applied`));
      insights.push(recommendation('Learnings may not match current work patterns'));
    } else {
      insights.push(recommendation('Build learnings by running more sessions'));
    }
  }

  return insights;
}

export function collectDedupInsights(context: CompactAnalyticsCollectorContext): CompactAnalyticsInsight[] {
  const dedup = context.summary.bySystem['dedup'];
  if (!dedup) return [];

  const blocked = dedup.events['duplicate_found'] || 0;
  if (blocked <= 0) return [];

  const estHours = Math.round(blocked * 0.25 * 10) / 10;
  return [working(`Dedup: ${blocked} duplicates blocked (~${estHours}h saved)`)];
}

export function collectSpindleSystemInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const spindle = context.summary.bySystem['spindle'];
  if (!spindle) return [];

  const triggered = spindle.events['triggered'] || 0;
  const checks = spindle.events['check_passed'] || 0;

  if (triggered > 0) {
    return [working(`Spindle: ${triggered} loops prevented`)];
  }

  if (checks === 0) {
    return [attention('Spindle: not active (no checks recorded)')];
  }

  return [];
}

export function collectSectorsInsights(context: CompactAnalyticsCollectorContext): CompactAnalyticsInsight[] {
  const sectors = context.summary.bySystem['sectors'];
  if (!sectors) return [];

  const picks = sectors.events['picked'] || 0;
  if (picks > 1) {
    return [working(`Sectors: ${picks} rotations for coverage`)];
  }

  if (picks === 1) {
    return [
      attention('Sectors: only 1 pick (limited rotation)'),
      recommendation('Run multi-cycle sessions (--hours) for better coverage'),
    ];
  }

  return [];
}

export function collectWaveInsights(context: CompactAnalyticsCollectorContext): CompactAnalyticsInsight[] {
  const wave = context.summary.bySystem['wave'];
  if (!wave) return [];

  const partitions = wave.events['partitioned'] || 0;
  return partitions > 0 ? [working(`Wave: ${partitions} parallel partitions`)] : [];
}

export function collectSessionSuccessInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const totalCompleted = context.history.reduce((sum, entry) => sum + entry.ticketsCompleted, 0);
  const totalFailed = context.history.reduce((sum, entry) => sum + entry.ticketsFailed, 0);

  if (totalCompleted <= 0) {
    return [];
  }

  const total = totalCompleted + totalFailed;
  const successRate = total > 0
    ? Math.round(totalCompleted / total * 100)
    : 0;

  if (successRate >= 80) {
    return [
      working(`Success rate: ${successRate}% (${totalCompleted}/${total} tickets)`),
    ];
  }

  return [
    attention(`Success rate: ${successRate}% (below 80% target)`),
    recommendation('Review failed tickets for patterns'),
  ];
}

export function collectTimingInsights(context: CompactAnalyticsCollectorContext): CompactAnalyticsInsight[] {
  const timingHistory = context.history.filter(
    (
      entry,
    ): entry is RunHistoryEntry & {
      phaseTiming: NonNullable<RunHistoryEntry['phaseTiming']>;
    } => entry.phaseTiming !== undefined && entry.phaseTiming !== null,
  );

  if (timingHistory.length === 0) {
    return [];
  }

  let tScout = 0;
  let tExec = 0;
  let tQa = 0;
  let tGit = 0;

  for (const entry of timingHistory) {
    tScout += entry.phaseTiming.totalScoutMs;
    tExec += entry.phaseTiming.totalExecuteMs;
    tQa += entry.phaseTiming.totalQaMs;
    tGit += entry.phaseTiming.totalGitMs;
  }

  const total = tScout + tExec + tQa + tGit;
  if (total <= 0) {
    return [];
  }

  const formatPhase = (ms: number): string => {
    const pct = Math.round(ms / total * 100);
    const mins = (ms / 60000).toFixed(1);
    return `${mins}m (${pct}%)`;
  };

  return [
    working(`Timing: Scout ${formatPhase(tScout)} | Exec ${formatPhase(tExec)} | QA ${formatPhase(tQa)} | Git ${formatPhase(tGit)}`),
  ];
}

export function collectCategoryPerformanceInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const runState = readRunState(context.repoRoot);
  const categoryStats = runState.categoryStats;

  if (!categoryStats || Object.keys(categoryStats).length === 0) {
    return [];
  }

  const categoryLines: string[] = [];
  for (const [category, stats] of Object.entries(categoryStats).sort((a, b) => b[1].successRate - a[1].successRate)) {
    if (stats.proposals === 0) continue;
    const pct = Math.round(stats.successRate * 100);
    const confidence = stats.confidenceAdjustment > 0
      ? `+${stats.confidenceAdjustment}`
      : `${stats.confidenceAdjustment}`;
    categoryLines.push(`${category} ${pct}% (${stats.success}/${stats.proposals}) conf:${confidence}`);
  }

  if (categoryLines.length === 0) {
    return [];
  }

  return [working(`Categories: ${categoryLines.slice(0, 4).join(' | ')}`)];
}

export function collectPrOutcomesInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const summary = analyzePrOutcomes(context.repoRoot);
  if (summary.total <= 0) {
    return [];
  }

  const mergeRatePct = Math.round(summary.mergeRate * 100);
  let message = `PRs: ${summary.total} total | ${summary.merged} merged (${mergeRatePct}%) | ${summary.closed} closed | ${summary.open} open`;

  if (summary.avgTimeToMergeMs !== null) {
    const hours = (summary.avgTimeToMergeMs / 3600000).toFixed(1);
    message += ` | avg merge: ${hours}h`;
  }

  return [working(message)];
}

export function collectErrorPatternInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const patterns = analyzeErrorLedger(context.repoRoot);
  if (patterns.length === 0) {
    return [];
  }

  const topPatterns = patterns
    .slice(0, 3)
    .map((pattern) => `${pattern.failureType}: ${pattern.count} (cmd: ${pattern.failedCommand})`)
    .join(' | ');

  return [attention(`Error patterns: ${topPatterns}`)];
}

export function collectCostInsights(context: CompactAnalyticsCollectorContext): CompactAnalyticsInsight[] {
  const costHistory = context.history.filter(
    (
      entry,
    ): entry is RunHistoryEntry & {
      tokenUsage: NonNullable<RunHistoryEntry['tokenUsage']>;
    } => entry.tokenUsage !== undefined && entry.tokenUsage !== null,
  );

  const nowMs = context.nowMs ?? Date.now();
  const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
  const recentCostHistory = costHistory.filter((entry) =>
    new Date(entry.timestamp).getTime() > sevenDaysAgo,
  );

  if (recentCostHistory.length === 0) {
    return [];
  }

  let totalCost = 0;
  let ticketCount = 0;

  for (const entry of recentCostHistory) {
    totalCost += entry.tokenUsage.totalCostUsd;
    ticketCount += entry.ticketsCompleted + entry.ticketsFailed;
  }

  const perTicket = ticketCount > 0
    ? (totalCost / ticketCount).toFixed(2)
    : '?';

  return [
    working(`Cost (7d): $${totalCost.toFixed(2)} across ${recentCostHistory.length} sessions | $${perTicket}/ticket`),
  ];
}

export function collectLearningRoiInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const runState = readRunState(context.repoRoot);
  const snapshots = runState.learningSnapshots ?? [];

  if (snapshots.length === 0) {
    return [];
  }

  const latest = snapshots[snapshots.length - 1];
  const effectivenessPct = Math.round(latest.successRate * 100);
  const lowPerformerStr = latest.lowPerformers.length > 0
    ? ` | ${latest.lowPerformers.length} low performers`
    : '';

  return [working(`Learning ROI: ${effectivenessPct}% effective${lowPerformerStr}`)];
}

export function collectSpindleIncidentInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const incidents = analyzeSpindleIncidents(context.repoRoot);
  if (incidents.length === 0) {
    return [];
  }

  const totalIncidents = incidents.reduce((sum, incident) => sum + incident.count, 0);
  const breakdown = incidents
    .slice(0, 3)
    .map((incident) => `${incident.trigger} (${incident.count})`)
    .join(', ');

  if (totalIncidents > 3) {
    return [attention(`Spindle: ${totalIncidents} incidents | ${breakdown}`)];
  }

  return [working(`Spindle incidents: ${totalIncidents} | ${breakdown}`)];
}

export function collectShutdownReasonInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const reasonCounts: Record<string, number> = {};

  for (const entry of context.history) {
    const reason = entry.stoppedReason || 'unknown';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  const reasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);
  if (reasons.length === 0) {
    return [];
  }

  const reasonStr = reasons.map(([reason, count]) => `${reason}: ${count}`).join(' | ');
  return [working(`Shutdown reasons: ${reasonStr}`)];
}

export function collectDrillPerformanceInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const drillSessions = context.history.filter(
    (
      entry,
    ): entry is RunHistoryEntry & {
      drillStats: NonNullable<RunHistoryEntry['drillStats']>;
    } => entry.drillStats !== undefined && entry.drillStats !== null && entry.drillStats.trajectoriesGenerated > 0,
  );

  if (drillSessions.length === 0) {
    return [];
  }

  let totalTrajectories = 0;
  let totalStepsCompleted = 0;
  let totalStepsFailed = 0;
  let totalSteps = 0;

  for (const entry of drillSessions) {
    totalTrajectories += entry.drillStats.trajectoriesGenerated;
    totalStepsCompleted += entry.drillStats.stepsCompleted;
    totalStepsFailed += entry.drillStats.stepsFailed;
    totalSteps += entry.drillStats.stepsTotal;
  }

  const overallRate = totalSteps > 0
    ? Math.round(totalStepsCompleted / totalSteps * 100)
    : 0;
  let message = `Drill: ${totalTrajectories} trajectories across ${drillSessions.length} sessions | ${totalStepsCompleted}/${totalSteps} steps (${overallRate}%) | ${totalStepsFailed} failed`;

  if (drillSessions.length >= 4) {
    const mid = Math.floor(drillSessions.length / 2);
    const firstHalf = drillSessions.slice(mid);
    const secondHalf = drillSessions.slice(0, mid);

    const firstTotal = firstHalf.reduce((sum, entry) => sum + entry.drillStats.stepsTotal, 0);
    const firstRate = firstTotal > 0
      ? Math.round(firstHalf.reduce((sum, entry) => sum + entry.drillStats.stepsCompleted, 0) / firstTotal * 100)
      : 0;

    const secondTotal = secondHalf.reduce((sum, entry) => sum + entry.drillStats.stepsTotal, 0);
    const secondRate = secondTotal > 0
      ? Math.round(secondHalf.reduce((sum, entry) => sum + entry.drillStats.stepsCompleted, 0) / secondTotal * 100)
      : 0;

    const trend = secondRate > firstRate
      ? 'improving'
      : secondRate < firstRate
        ? 'declining'
        : 'stable';
    message += ` | trend: ${trend} (${firstRate}%→${secondRate}%)`;
  }

  return [working(message)];
}

export function collectTrajectoryProgressInsights(
  context: CompactAnalyticsCollectorContext,
): CompactAnalyticsInsight[] {
  const trajectoryState = loadTrajectoryState(context.repoRoot);
  if (!trajectoryState) {
    return [];
  }

  const trajectories = loadTrajectories(context.repoRoot);
  const trajectory = trajectories.find((entry) => entry.name === trajectoryState.trajectoryName);

  const totalSteps = Object.keys(trajectoryState.stepStates).length;
  const completed = Object.values(trajectoryState.stepStates).filter((step) => step.status === 'completed').length;
  const failed = Object.values(trajectoryState.stepStates).filter((step) => step.status === 'failed').length;
  const active = Object.values(trajectoryState.stepStates).find((step) => step.status === 'active');

  const activeTitle = active && trajectory
    ? trajectory.steps.find((step) => step.id === active.stepId)?.title ?? active.stepId
    : active?.stepId ?? null;
  const paused = trajectoryState.paused ? ' (paused)' : '';

  if (completed === totalSteps) {
    return [
      working(`Trajectory "${trajectoryState.trajectoryName}": complete (${totalSteps}/${totalSteps} steps)`),
    ];
  }

  if (activeTitle) {
    return [
      working(`Trajectory "${trajectoryState.trajectoryName}": ${completed}/${totalSteps} steps${paused} | current: ${activeTitle}`),
    ];
  }

  const statusParts = [`${completed}/${totalSteps} steps`];
  if (failed > 0) statusParts.push(`${failed} failed`);

  return [
    attention(`Trajectory "${trajectoryState.trajectoryName}": ${statusParts.join(', ')}${paused} | stalled`),
  ];
}

function working(message: string): CompactAnalyticsInsight {
  return { section: 'working', message };
}

function attention(message: string): CompactAnalyticsInsight {
  return { section: 'attention', message };
}

function recommendation(message: string): CompactAnalyticsInsight {
  return { section: 'recommendations', message };
}
