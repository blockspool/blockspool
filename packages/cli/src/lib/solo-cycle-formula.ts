/**
 * Formula and category selection logic for auto-mode cycles.
 */

import { readRunState, isDocsAuditDue, type FormulaStats } from './run-state.js';
import { loadFormula, type Formula } from './formulas.js';
import type { TasteProfile } from './taste-profile.js';

export interface CycleFormulaContext {
  activeFormula: Formula | null;
  sessionPhase: 'warmup' | 'deep' | 'cooldown';
  deepFormula: Formula | null;
  docsAuditFormula: Formula | null;
  isContinuous: boolean;
  repoRoot: string;
  options: {
    docsAuditInterval?: string;
    safe?: boolean;
    allow?: string;
    block?: string;
    tests?: boolean;
  };
  config: { auto?: { docsAuditInterval?: number; docsAudit?: boolean } } | null;
  sectorProductionFileCount?: number;
  /** Active lens from lens rotation (overrides default formula selection when set) */
  currentLens?: string;
}

/**
 * Determine the formula to use for a given cycle.
 */
export function getCycleFormula(ctx: CycleFormulaContext, cycle: number): Formula | null {
  const { activeFormula, sessionPhase, deepFormula, docsAuditFormula, isContinuous, repoRoot, options, config } = ctx;

  if (activeFormula) return activeFormula;

  // Session arc: cooldown phase → no formula (light work only)
  if (sessionPhase === 'cooldown') return null;

  const rs = readRunState(repoRoot);

  // Hard guarantee: deep at least every 7 cycles
  if (deepFormula && isContinuous) {
    const deepStats = rs.formulaStats['deep'];
    if (cycle - (deepStats?.lastResetCycle ?? 0) >= 7) {
      // Session arc: warmup phase → skip deep
      if (sessionPhase !== 'warmup' && (ctx.sectorProductionFileCount ?? Infinity) >= 25) return deepFormula;
    }
  }

  // Docs-audit: keep existing periodic logic
  if (docsAuditFormula && repoRoot) {
    let interval = options.docsAuditInterval
      ? parseInt(options.docsAuditInterval, 10)
      : config?.auto?.docsAuditInterval ?? 3;
    const docsStats = rs.formulaStats['docs-audit'];
    if (docsStats && docsStats.cycles >= 3 && docsStats.proposalsGenerated === 0) {
      interval = Math.max(interval, 10);
    }
    if (config?.auto?.docsAudit !== false && isDocsAuditDue(repoRoot, interval)) return docsAuditFormula;
  }

  // Lens rotation override — when a non-default lens is active, use it
  if (ctx.currentLens && ctx.currentLens !== 'default') {
    const lensFormula = loadFormula(ctx.currentLens, repoRoot);
    if (lensFormula) return lensFormula;
  }

  // Session arc: warmup phase → skip UCB1 deep selection
  if (sessionPhase === 'warmup') return null;

  // UCB1 selection: default vs deep
  if (!deepFormula || !isContinuous) return null;
  const candidates = [
    { name: 'default', formula: null as typeof deepFormula | null },
    { name: 'deep', formula: deepFormula },
  ];
  let bestScore = -Infinity;
  let bestFormula: typeof deepFormula | null = null;
  for (const c of candidates) {
    const stats = rs.formulaStats[c.name];
    const alpha = (stats?.recentTicketsSucceeded ?? 0) + 1;
    const beta = ((stats?.recentTicketsTotal ?? 0) - (stats?.recentTicketsSucceeded ?? 0)) + 1;
    const exploitation = alpha / (alpha + beta);
    const exploration = Math.sqrt(2 * Math.log(Math.max(cycle, 1)) / Math.max(stats?.recentCycles ?? 0, 1));
    if (exploitation + exploration > bestScore) {
      bestScore = exploitation + exploration;
      bestFormula = c.formula;
    }
  }
  if (bestFormula === deepFormula && (ctx.sectorProductionFileCount ?? Infinity) < 25) {
    return null;
  }
  return bestFormula;
}

/**
 * Get allow/block category lists for a given formula and session context.
 */
export function getCycleCategories(ctx: CycleFormulaContext, formula: Formula | null): { allow: string[]; block: string[] } {
  const { sessionPhase, options } = ctx;

  // Session arc: cooldown → restrict to light categories
  if (sessionPhase === 'cooldown') {
    return { allow: ['docs', 'cleanup', 'types'], block: ['deps', 'auth', 'config', 'migration'] };
  }
  // --allow overrides everything: use exactly these categories
  if (options.allow) {
    const userAllow = options.allow.split(',').map(s => s.trim()).filter(Boolean);
    // Block everything not in the allow list (no implicit blocks)
    return { allow: userAllow, block: [] };
  }

  let allow = formula?.categories
    ? formula.categories as string[]
    : options.safe
      ? ['refactor', 'docs', 'types', 'perf']
      : ['refactor', 'docs', 'types', 'perf', 'security', 'fix', 'cleanup'];
  // --tests flag explicitly includes test proposals in the focus list
  if (options.tests && !allow.includes('test')) {
    allow = [...allow, 'test'];
  }
  let block = formula?.categories
    ? []
    : options.safe
      ? ['deps', 'auth', 'config', 'migration', 'security', 'fix', 'cleanup']
      : ['deps', 'auth', 'config', 'migration'];

  // --block adds categories to the block list and removes them from allow
  if (options.block) {
    const userBlock = options.block.split(',').map(s => s.trim()).filter(Boolean);
    block = [...new Set([...block, ...userBlock])];
    allow = allow.filter(c => !userBlock.includes(c));
  }

  return { allow, block };
}

/**
 * Select 2-3 non-conflicting formulas for parallel scouting.
 *
 * Selection criteria:
 * - Taste profile: preferred formula categories score higher
 * - Category diversity: don't pick two formulas with overlapping categories
 * - Cooldown: respect per-formula cooldowns from FormulaStats
 * - Max formulas: configurable, default 2, max 3
 */
export function getParallelFormulas(
  state: {
    autoConf: Record<string, any>;
    tasteProfile: TasteProfile | null;
    activeFormula: Formula | null;
    deepFormula: Formula | null;
    currentFormulaName: string;
    repoRoot: string;
    cycleCount: number;
  },
  allFormulas: Formula[],
  maxFormulas?: number,
): Formula[] {
  const max = Math.min(maxFormulas ?? 2, 3);

  // If a user-specified formula is active, only run that one
  if (state.activeFormula) return [state.activeFormula];

  if (allFormulas.length <= 1) return allFormulas.slice(0, 1);

  // Exclude special-purpose formulas from parallel selection
  const excluded = new Set(['deep', 'docs-audit']);
  const candidates = allFormulas.filter(f => !excluded.has(f.name));

  if (candidates.length === 0) return allFormulas.slice(0, 1);

  const rs = readRunState(state.repoRoot);
  const selected: Formula[] = [];
  const usedCategories = new Set<string>();

  // Score each formula
  const scored = candidates.map(f => {
    let score = 0;
    const taste = state.tasteProfile;

    // Taste preference: boost formulas whose categories align with preferred
    if (taste) {
      const categories = f.categories ?? [];
      for (const cat of categories) {
        if (taste.preferredCategories.includes(cat)) score += 3;
        if (taste.avoidCategories.includes(cat)) score -= 5;
      }
    }

    // Don't re-pick the current formula (minor penalty)
    if (f.name === state.currentFormulaName) score -= 1;

    // Per-formula cooldown: penalize formulas that ran very recently
    const stats: FormulaStats | undefined = rs.formulaStats[f.name];
    if (stats && stats.recentCycles > 0) {
      const cyclesSinceLast = state.cycleCount - (stats.lastResetCycle ?? 0);
      if (cyclesSinceLast <= 1) score -= 3; // just ran — penalize
    }

    // Boost formulas with better recent success rates
    if (stats && stats.recentTicketsTotal > 0) {
      const successRate = stats.recentTicketsSucceeded / stats.recentTicketsTotal;
      score += Math.round(successRate * 2);
    }

    return { formula: f, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  for (const { formula } of scored) {
    if (selected.length >= max) break;

    const categories = formula.categories ?? [];

    // Check category overlap with already-selected formulas
    if (selected.length > 0 && categories.length > 0) {
      const overlapCount = categories.filter(c => usedCategories.has(c)).length;
      // Skip if more than half the categories overlap
      if (overlapCount > categories.length / 2) continue;
    }

    selected.push(formula);
    for (const c of categories) usedCategories.add(c);
  }

  return selected;
}
