/**
 * Drill status tool — exposes drill mode health metrics via MCP.
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../state.js';

interface DrillHistoryEntry {
  name: string;
  description: string;
  stepsTotal: number;
  stepsCompleted: number;
  stepsFailed: number;
  outcome: 'completed' | 'stalled';
  categories: string[];
  scopes: string[];
  timestamp?: number;
}

interface DrillHistoryFile {
  entries: DrillHistoryEntry[];
  coveredCategories: Record<string, number>;
  coveredScopes: Record<string, number>;
}

function loadDrillHistory(projectPath: string): DrillHistoryFile {
  const empty: DrillHistoryFile = { entries: [], coveredCategories: {}, coveredScopes: {} };
  try {
    const filePath = join(projectPath, '.promptwheel', 'drill-history.json');
    if (!existsSync(filePath)) return empty;
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return empty;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return empty;
    return {
      entries: Array.isArray(data.entries) ? data.entries : [],
      coveredCategories: (data.coveredCategories && typeof data.coveredCategories === 'object' && !Array.isArray(data.coveredCategories))
        ? data.coveredCategories : {},
      coveredScopes: (data.coveredScopes && typeof data.coveredScopes === 'object' && !Array.isArray(data.coveredScopes))
        ? data.coveredScopes : {},
    };
  } catch {
    return empty;
  }
}

function computeDrillMetrics(entries: DrillHistoryEntry[]) {
  if (entries.length === 0) {
    return { totalTrajectories: 0, completionRate: 0, weightedCompletionRate: 0, topCategories: [] as string[], stalledCategories: [] as string[] };
  }

  const completed = entries.filter(e => e.outcome === 'completed').length;
  const completionRate = completed / entries.length;

  // Recency-weighted completion rate (half-life ~5 entries)
  const DECAY_LAMBDA = Math.LN2 / 5;
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < entries.length; i++) {
    const age = entries.length - 1 - i;
    const weight = Math.exp(-DECAY_LAMBDA * age);
    weightedSum += (entries[i].outcome === 'completed' ? 1 : 0) * weight;
    weightTotal += weight;
  }
  const weightedCompletionRate = weightTotal > 0 ? weightedSum / weightTotal : 0;

  // Category success rates with recency weighting
  const catStats: Record<string, { completed: number; total: number; weightedCompleted: number; weightedTotal: number }> = {};
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const age = entries.length - 1 - i;
    const weight = Math.exp(-DECAY_LAMBDA * age);
    for (const cat of e.categories) {
      const s = catStats[cat] ??= { completed: 0, total: 0, weightedCompleted: 0, weightedTotal: 0 };
      s.total++;
      s.weightedTotal += weight;
      if (e.outcome === 'completed') {
        s.completed++;
        s.weightedCompleted += weight;
      }
    }
  }

  const sorted = Object.entries(catStats).sort((a, b) => {
    const rateA = a[1].weightedTotal > 0 ? a[1].weightedCompleted / a[1].weightedTotal : 0;
    const rateB = b[1].weightedTotal > 0 ? b[1].weightedCompleted / b[1].weightedTotal : 0;
    return rateB - rateA;
  });

  const topCategories = sorted
    .filter(([, s]) => s.weightedTotal > 0 && (s.weightedCompleted / s.weightedTotal) >= 0.5)
    .map(([c]) => c);

  const stalledCategories = sorted
    .filter(([, s]) => s.total >= 2 && s.weightedTotal > 0 && (s.weightedCompleted / s.weightedTotal) < 0.3)
    .map(([c]) => c);

  return { totalTrajectories: entries.length, completionRate, weightedCompletionRate, topCategories, stalledCategories };
}

export function registerDrillTools(server: McpServer, getState: () => SessionManager) {
  server.tool(
    'promptwheel_drill_status',
    'Get drill mode status: trajectory history, completion rates, top/stalled categories, and active trajectory progress.',
    {},
    async () => {
      const state = getState();
      try {
        const history = loadDrillHistory(state.projectPath);
        const metrics = computeDrillMetrics(history.entries);

        // Check for active trajectory
        let activeTrajectory: { name: string; progress: string } | null = null;
        try {
          const trajStatePath = join(state.projectPath, '.promptwheel', 'trajectory-state.json');
          if (existsSync(trajStatePath)) {
            const trajState = JSON.parse(readFileSync(trajStatePath, 'utf-8'));
            if (trajState && trajState.trajectoryName && !trajState.paused) {
              const completedSteps = Object.values(trajState.stepStates ?? {})
                .filter((s: any) => s.status === 'completed').length;
              const totalSteps = Object.keys(trajState.stepStates ?? {}).length;
              activeTrajectory = {
                name: trajState.trajectoryName,
                progress: `${completedSteps}/${totalSteps}`,
              };
            }
          }
        } catch { /* non-fatal */ }

        // Determine if drill is enabled from config
        let enabled = true;
        try {
          const configPath = join(state.projectPath, '.promptwheel', 'config.json');
          if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'));
            if (config?.auto?.drill?.enabled === false) {
              enabled = false;
            }
          }
        } catch { /* non-fatal */ }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              enabled,
              totalTrajectories: metrics.totalTrajectories,
              completionRate: Math.round(metrics.completionRate * 100) / 100,
              weightedCompletionRate: Math.round(metrics.weightedCompletionRate * 100) / 100,
              topCategories: metrics.topCategories,
              stalledCategories: metrics.stalledCategories,
              activeTrajectory,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );
}
