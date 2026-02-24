/**
 * Multi-lens rotation — cycle through different formula perspectives
 * when sector scanning exhausts under the current lens.
 *
 * Instead of idling when all sectors are scanned, advance to the next
 * formula lens (e.g. security-audit, type-safety, cleanup) and reset
 * sector scanning. Only truly idle when ALL lenses have covered all sectors.
 */

import { readRunState } from './run-state.js';
import { listFormulas, loadFormula, type Formula } from './formulas.js';

/** Lenses excluded from rotation (they have their own periodic scheduling) */
const EXCLUDED_LENSES = new Set(['deep', 'docs-audit']);

/** Default lenses when no user formula is specified */
const DEFAULT_LENSES = ['default', 'security-audit', 'type-safety', 'cleanup', 'test-coverage', 'docs'];

/**
 * Build the ordered lens rotation using UCB1 scoring.
 * Returns formula names, ordered by exploration/exploitation balance.
 */
export function buildLensRotation(repoRoot: string, userFormula: Formula | null): string[] {
  // If user explicitly set a formula, no rotation
  if (userFormula) return [userFormula.name];

  const allFormulas = listFormulas(repoRoot);
  const allNames = new Set(allFormulas.map(f => f.name));

  // Start with default lenses that actually exist, then append any
  // user-defined formulas not already included
  const candidates: string[] = [];
  for (const name of DEFAULT_LENSES) {
    if (allNames.has(name) && !EXCLUDED_LENSES.has(name)) {
      candidates.push(name);
    }
  }
  for (const f of allFormulas) {
    if (!EXCLUDED_LENSES.has(f.name) && !candidates.includes(f.name)) {
      candidates.push(f.name);
    }
  }

  // Ensure 'default' is always included and first attempted
  if (!candidates.includes('default')) candidates.unshift('default');

  // Score with UCB1 using formula stats from run-state
  const rs = readRunState(repoRoot);
  const totalCycles = Math.max(rs.totalCycles, 1);

  const scored = candidates.map(name => {
    const stats = rs.formulaStats[name];
    const alpha = (stats?.recentTicketsSucceeded ?? 0) + 1;
    const beta = ((stats?.recentTicketsTotal ?? 0) - (stats?.recentTicketsSucceeded ?? 0)) + 1;
    const exploitation = alpha / (alpha + beta);
    const exploration = Math.sqrt(2 * Math.log(totalCycles) / Math.max(stats?.recentCycles ?? 0, 1));
    return { name, score: exploitation + exploration };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.name);
}

/**
 * Advance to the next lens in rotation.
 * Returns true if a new lens was activated, false if all lenses exhausted.
 */
export function advanceLens(state: {
  lensRotation: string[];
  lensIndex: number;
  currentLens: string;
  lensMatrix: Map<string, Set<string>>;
  sectorState: { sectors: { path: string }[] } | null;
  lensZeroYieldPairs: Set<string>;
  sessionPhase: string;
}): boolean {
  // No rotation during warmup
  if (state.sessionPhase === 'warmup') return false;

  const totalSectors = state.sectorState?.sectors.length ?? 0;
  if (totalSectors === 0) return false;

  for (let i = 1; i < state.lensRotation.length; i++) {
    const nextIndex = (state.lensIndex + i) % state.lensRotation.length;
    const nextLens = state.lensRotation[nextIndex];
    const scannedUnder = state.lensMatrix.get(nextLens)?.size ?? 0;

    // Check if this lens still has unscanned sectors
    // (accounting for zero-yield pairs that should be skipped)
    const zeroYieldCount = state.sectorState?.sectors.filter(
      s => state.lensZeroYieldPairs.has(`${nextLens}:${s.path}`),
    ).length ?? 0;

    if (scannedUnder + zeroYieldCount < totalSectors) {
      state.lensIndex = nextIndex;
      state.currentLens = nextLens;
      return true;
    }
  }

  return false; // All lenses exhausted
}

/**
 * Record that a [lens, sector] pair produced zero proposals.
 */
export function recordZeroYield(state: {
  currentLens: string;
  currentSectorId: string | null;
  lensZeroYieldPairs: Set<string>;
}, proposalCount: number): void {
  if (proposalCount === 0 && state.currentSectorId) {
    state.lensZeroYieldPairs.add(`${state.currentLens}:${state.currentSectorId}`);
  }
}

/**
 * Record that a sector was scanned under the current lens.
 */
export function recordLensScan(state: {
  currentLens: string;
  currentSectorId: string | null;
  lensMatrix: Map<string, Set<string>>;
}): void {
  if (!state.currentSectorId) return;
  let set = state.lensMatrix.get(state.currentLens);
  if (!set) { set = new Set(); state.lensMatrix.set(state.currentLens, set); }
  set.add(state.currentSectorId);
}
