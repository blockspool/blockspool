import type { DatabaseAdapter } from '@promptwheel/core/db';
import { projects, tickets, runs } from '@promptwheel/core/repos';
import {
  getAllArtifacts,
  getArtifactByRunId,
  getArtifactsForRun,
  type ArtifactType,
} from './artifacts.js';
import type { StatusOutput } from './solo-utils.js';

type LastExecuteSummary = Awaited<ReturnType<typeof runs.getSummary>>['lastExecute'];

export interface ExecuteStatusDetails {
  spindleInfo: { reason?: string; artifactPath?: string } | null;
  completionOutcome: string | null;
}

interface DrillJsonSummary {
  totalTrajectories: number;
  completionRate: number;
  topCategories: string[];
  stalledCategories: string[];
  activeTrajectory: {
    name: string;
    progress: string;
  } | null;
}

interface SpinJsonSummary {
  qualityRate: number;
  qualitySignals: unknown | null;
  disabledCommands: Array<{ name: string; reason: string; disabledAt: number }>;
  processInsights: number;
  qaCommands: Record<string, { successRate: number; avgDurationMs: number; totalRuns: number }>;
  categoryStats: unknown | null;
  learningSnapshots: unknown | null;
  errorPatterns: unknown;
  prOutcomes: unknown;
  spindleIncidents: unknown;
  drill?: DrillJsonSummary;
}

export type StatusJsonOutput = StatusOutput & {
  spin?: SpinJsonSummary;
};

export interface SpinTextSummary {
  qualityRate: number;
  qualitySignals: {
    totalTickets: number;
    firstPassSuccess: number;
    qaPassed: number;
    qaFailed: number;
  } | null;
  currentConfidence: number;
  originalConfidence: number;
  confidenceDelta: number;
  disabledCommands: string[];
  processInsightsCount: number;
  qaCommands: Array<{
    name: string;
    totalRuns: number;
    successes: number;
    avgDurationMs: number;
  }>;
}

export interface DrillTextSummary {
  totalTrajectories: number;
  completedTrajectories: number;
  stalledTrajectories: number;
  completionRate: number;
  ambition: string;
  topCategories: string[];
  stalledCategories: string[];
  activeTrajectory: {
    name: string;
    completedSteps: number | null;
    totalSteps: number | null;
  } | null;
}

export const DEFAULT_INSPECT_ARTIFACT_TYPES: ArtifactType[] = [
  'runs',
  'executions',
  'diffs',
  'violations',
  'proposals',
  'spindle',
];

export async function getExecuteStatusDetails(
  repoRoot: string,
  adapter: DatabaseAdapter,
  lastExecute: LastExecuteSummary,
): Promise<ExecuteStatusDetails> {
  if (!lastExecute) {
    return {
      spindleInfo: null,
      completionOutcome: null,
    };
  }

  const { getPromptwheelDir } = await import('./solo-config.js');
  const baseDir = getPromptwheelDir(repoRoot);

  let spindleInfo: { reason?: string; artifactPath?: string } | null = null;
  if (lastExecute.status === 'failure' && lastExecute.id) {
    const spindleArtifact = getArtifactByRunId<{ reason?: string }>(baseDir, lastExecute.id, 'spindle');
    if (spindleArtifact) {
      spindleInfo = {
        reason: spindleArtifact.data.reason,
        artifactPath: spindleArtifact.path,
      };
    }
  }

  let completionOutcome: string | null = null;
  if (lastExecute.status === 'success' && lastExecute.id) {
    const fullRun = await runs.getById(adapter, lastExecute.id);
    if (fullRun?.metadata?.completionOutcome) {
      completionOutcome = String(fullRun.metadata.completionOutcome);
    }
  }

  return { spindleInfo, completionOutcome };
}

export async function buildStatusJsonOutput(
  repoRoot: string,
  dbPath: string,
  adapter: DatabaseAdapter,
): Promise<StatusJsonOutput> {
  const output: StatusJsonOutput = {
    dbPath,
    projects: [],
  };

  const projectList = await projects.list(adapter);
  for (const project of projectList) {
    const counts = await tickets.countByStatus(adapter, project.id);
    const summary = await runs.getSummary(adapter, project.id);
    const executeDetails = await getExecuteStatusDetails(repoRoot, adapter, summary.lastExecute);

    output.projects.push({
      id: project.id,
      name: project.name,
      ticketCounts: counts,
      lastScout: summary.lastScout ? {
        ...summary.lastScout,
        completedAt: summary.lastScout.completedAt?.toISOString() ?? null,
      } : null,
      lastQa: summary.lastQa ? {
        ...summary.lastQa,
        completedAt: summary.lastQa.completedAt?.toISOString() ?? null,
      } : null,
      lastExecute: summary.lastExecute ? {
        ...summary.lastExecute,
        completedAt: summary.lastExecute.completedAt?.toISOString() ?? null,
        completionOutcome: executeDetails.completionOutcome,
      } : null,
      activeRuns: summary.activeRuns,
    });
  }

  const spinJson = await loadSpinJsonSummary(repoRoot);
  if (spinJson) {
    output.spin = spinJson;
  }

  return output;
}

export async function loadSpinTextSummary(repoRoot: string): Promise<SpinTextSummary | null> {
  try {
    const { readRunState, getQualityRate } = await import('./run-state.js');
    const { loadQaStats } = await import('./qa-stats.js');
    const { loadLearnings } = await import('./learnings.js');

    const runState = readRunState(repoRoot);
    const qualityRate = getQualityRate(repoRoot);
    const qaStats = loadQaStats(repoRoot);
    const allLearnings = loadLearnings(repoRoot, 0);
    const processInsights = allLearnings.filter((learning) => learning.source.type === 'process_insight');

    const originalConfidence = 20;
    const runStateRecord = runState as unknown as Record<string, unknown>;
    const effectiveMinConfidence = typeof runStateRecord.effectiveMinConfidence === 'number'
      ? runStateRecord.effectiveMinConfidence
      : undefined;
    const confidenceDelta = typeof effectiveMinConfidence === 'number'
      ? effectiveMinConfidence - originalConfidence
      : 0;

    return {
      qualityRate,
      qualitySignals: runState.qualitySignals ? {
        totalTickets: runState.qualitySignals.totalTickets,
        firstPassSuccess: runState.qualitySignals.firstPassSuccess,
        qaPassed: runState.qualitySignals.qaPassed,
        qaFailed: runState.qualitySignals.qaFailed,
      } : null,
      currentConfidence: originalConfidence + confidenceDelta,
      originalConfidence,
      confidenceDelta,
      disabledCommands: qaStats.disabledCommands.map((entry) => entry.name),
      processInsightsCount: processInsights.length,
      qaCommands: Object.values(qaStats.commands),
    };
  } catch {
    return null;
  }
}

export async function loadDrillTextSummary(repoRoot: string): Promise<DrillTextSummary | null> {
  try {
    const { loadDrillHistory, computeDrillMetrics, computeAmbitionLevel } = await import('./solo-auto-drill.js');
    const { loadTrajectoryState, loadTrajectory } = await import('./trajectory.js');
    const drillData = loadDrillHistory(repoRoot);

    if (drillData.entries.length === 0) {
      return null;
    }

    const metrics = computeDrillMetrics(drillData.entries);
    const completed = drillData.entries.filter((entry) => entry.outcome === 'completed').length;
    const stalled = drillData.entries.filter((entry) => entry.outcome === 'stalled').length;
    const ambition = computeAmbitionLevel({
      drillHistory: drillData.entries,
    } as unknown as Parameters<typeof computeAmbitionLevel>[0]);

    const trajectoryState = loadTrajectoryState(repoRoot);
    let activeTrajectory: DrillTextSummary['activeTrajectory'] = null;
    if (trajectoryState) {
      const trajectory = loadTrajectory(repoRoot, trajectoryState.trajectoryName);
      if (trajectory) {
        const completedSteps = trajectory.steps.filter(
          (step) => trajectoryState.stepStates[step.id]?.status === 'completed',
        ).length;
        activeTrajectory = {
          name: trajectoryState.trajectoryName,
          completedSteps,
          totalSteps: trajectory.steps.length,
        };
      } else {
        activeTrajectory = {
          name: trajectoryState.trajectoryName,
          completedSteps: null,
          totalSteps: null,
        };
      }
    }

    return {
      totalTrajectories: metrics.totalTrajectories,
      completedTrajectories: completed,
      stalledTrajectories: stalled,
      completionRate: metrics.completionRate,
      ambition,
      topCategories: metrics.topCategories,
      stalledCategories: metrics.stalledCategories,
      activeTrajectory,
    };
  } catch {
    return null;
  }
}

export function listArtifactsForRun(baseDir: string, runId: string): Array<{ type: ArtifactType; path: string }> {
  const artifacts = getArtifactsForRun(baseDir, runId);
  const found: Array<{ type: ArtifactType; path: string }> = [];

  for (const [type, artifact] of Object.entries(artifacts) as Array<[ArtifactType, (typeof artifacts)[ArtifactType]]>) {
    if (artifact) {
      found.push({ type, path: artifact.path });
    }
  }

  return found;
}

export function buildArtifactsForRunJson(
  baseDir: string,
  runId: string,
): { runId: string; artifacts: Record<string, string> } {
  const found = listArtifactsForRun(baseDir, runId);
  return {
    runId,
    artifacts: Object.fromEntries(found.map((entry) => [entry.type, entry.path])),
  };
}

export function buildArtifactsByTypeJson(
  baseDir: string,
  types: ArtifactType[],
): Record<string, Array<{ id: string; path: string; timestamp: number }>> {
  const allArtifacts = getAllArtifacts(baseDir);
  const output: Record<string, Array<{ id: string; path: string; timestamp: number }>> = {};

  for (const type of types) {
    output[type] = allArtifacts[type] ?? [];
  }

  return output;
}

async function loadSpinJsonSummary(repoRoot: string): Promise<SpinJsonSummary | null> {
  try {
    const { readRunState, getQualityRate } = await import('./run-state.js');
    const { loadQaStats } = await import('./qa-stats.js');
    const { loadLearnings } = await import('./learnings.js');
    const { analyzeErrorLedger } = await import('./error-ledger.js');
    const { analyzePrOutcomes } = await import('./pr-outcomes.js');
    const { analyzeSpindleIncidents } = await import('./spindle-incidents.js');

    const runState = readRunState(repoRoot);
    const qaStats = loadQaStats(repoRoot);
    const allLearnings = loadLearnings(repoRoot, 0);

    let drillJson: DrillJsonSummary | null = null;
    try {
      const { loadDrillHistory, computeDrillMetrics } = await import('./solo-auto-drill.js');
      const { loadTrajectoryState, loadTrajectory } = await import('./trajectory.js');
      const drillHistory = loadDrillHistory(repoRoot);

      if (drillHistory.entries.length > 0) {
        const drillMetrics = computeDrillMetrics(drillHistory.entries);
        const trajectoryState = loadTrajectoryState(repoRoot);
        drillJson = {
          totalTrajectories: drillMetrics.totalTrajectories,
          completionRate: drillMetrics.completionRate,
          topCategories: drillMetrics.topCategories,
          stalledCategories: drillMetrics.stalledCategories,
          activeTrajectory: trajectoryState ? (() => {
            const trajectory = loadTrajectory(repoRoot, trajectoryState.trajectoryName);
            const completedSteps = trajectory
              ? trajectory.steps.filter((step) => trajectoryState.stepStates[step.id]?.status === 'completed').length
              : 0;
            const totalSteps = trajectory ? trajectory.steps.length : 0;
            return {
              name: trajectoryState.trajectoryName,
              progress: `${completedSteps}/${totalSteps}`,
            };
          })() : null,
        };
      }
    } catch {
      // Non-fatal
    }

    return {
      qualityRate: getQualityRate(repoRoot),
      qualitySignals: runState.qualitySignals ?? null,
      disabledCommands: qaStats.disabledCommands,
      processInsights: allLearnings.filter((learning) => learning.source.type === 'process_insight').length,
      qaCommands: Object.fromEntries(
        Object.entries(qaStats.commands).map(([name, stats]) => [name, {
          successRate: stats.totalRuns > 0 ? stats.successes / stats.totalRuns : -1,
          avgDurationMs: stats.avgDurationMs,
          totalRuns: stats.totalRuns,
        }]),
      ),
      categoryStats: runState.categoryStats ?? null,
      learningSnapshots: runState.learningSnapshots ?? null,
      errorPatterns: analyzeErrorLedger(repoRoot),
      prOutcomes: analyzePrOutcomes(repoRoot),
      spindleIncidents: analyzeSpindleIncidents(repoRoot),
      ...(drillJson && { drill: drillJson }),
    };
  } catch {
    return null;
  }
}
