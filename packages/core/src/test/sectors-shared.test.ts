import { describe, expect, it } from 'vitest';
import {
  AFFINITY_MIN_ATTEMPTS,
  EMA_OLD_WEIGHT,
  OUTCOME_DECAY_FACTOR,
  OUTCOME_DECAY_INTERVAL,
  POLISHED_YIELD_THRESHOLD,
  getSectorCategoryAffinity,
  pickNextSector,
  recordScanResult,
  recordTicketOutcome,
  suggestScopeAdjustment,
} from '../sectors/shared.js';
import type { Sector, SectorState } from '../sectors/shared.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = Date.UTC(2025, 0, 15, 12, 0, 0);
const FIXED_CYCLE = 42;

function makeSector(overrides: Partial<Sector> = {}): Sector {
  return {
    path: 'src/default',
    purpose: 'default',
    production: true,
    fileCount: 10,
    productionFileCount: 10,
    classificationConfidence: 'high',
    lastScannedAt: FIXED_NOW - DAY_MS,
    lastScannedCycle: FIXED_CYCLE - 2,
    scanCount: 1,
    proposalYield: 1,
    successCount: 0,
    failureCount: 0,
    ...overrides,
  };
}

function makeState(sectors: Sector[]): SectorState {
  return {
    version: 2,
    builtAt: '2025-01-15T12:00:00.000Z',
    sectors,
  };
}

function pickPathsInOrder(state: SectorState): string[] {
  const paths: string[] = [];
  while (true) {
    const next = pickNextSector(state, FIXED_CYCLE, FIXED_NOW);
    if (!next) break;
    paths.push(next.sector.path);
    state.sectors = state.sectors.filter(s => s.path !== next.sector.path);
  }
  return paths;
}

describe('pickNextSector deterministic priority order', () => {
  it('orders sectors by never-scanned, hub/dead-export tie-breakers, high-failure, barren, then polished', () => {
    const polished = makeSector({
      path: 'f-polished',
      scanCount: 6,
      proposalYield: 0.1,
      successCount: 0,
      failureCount: 0,
    });

    const state = makeState([
      makeSector({
        path: 'a-never-scanned',
        lastScannedAt: 0,
        lastScannedCycle: 0,
        scanCount: 0,
        proposalYield: 0,
      }),
      makeSector({
        path: 'b-hub-dead-high',
        isHub: true,
        deadExportCount: 8,
        proposalYield: 1.1,
      }),
      makeSector({
        path: 'c-hub-dead-low',
        isHub: true,
        deadExportCount: 2,
        proposalYield: 1.1,
      }),
      makeSector({
        path: 'd-high-failure',
        successCount: 1,
        failureCount: 3,
        proposalYield: 1.1,
      }),
      makeSector({
        path: 'e-barren',
        scanCount: 4,
        proposalYield: 0.2,
        successCount: 4,
        failureCount: 0,
      }),
      polished,
    ]);

    expect(pickPathsInOrder(state)).toEqual([
      'a-never-scanned',
      'b-hub-dead-high',
      'c-hub-dead-low',
      'd-high-failure',
      'e-barren',
      'f-polished',
    ]);
    expect(polished.polishedAt).toBe(FIXED_NOW);
  });

  it('uses fixed timestamps for temporal decay tie-breaks', () => {
    const state = makeState([
      makeSector({
        path: 'older',
        lastScannedAt: FIXED_NOW - 12 * DAY_MS,
        lastScannedCycle: 10,
      }),
      makeSector({
        path: 'newer',
        lastScannedAt: FIXED_NOW - 9 * DAY_MS,
        lastScannedCycle: 10,
      }),
    ]);

    const next = pickNextSector(state, FIXED_CYCLE, FIXED_NOW);
    expect(next?.sector.path).toBe('older');
  });
});

describe('recordScanResult deterministic updates', () => {
  it('applies EMA and scan metadata with explicit timestamp/cycle', () => {
    const state = makeState([
      makeSector({
        path: 'src/scan',
        proposalYield: 2,
        scanCount: 5,
      }),
    ]);

    recordScanResult(state, 'src/scan', 50, 6, undefined, FIXED_NOW);
    const sector = state.sectors[0];

    expect(sector.lastScannedAt).toBe(FIXED_NOW);
    expect(sector.lastScannedCycle).toBe(50);
    expect(sector.scanCount).toBe(6);
    expect(sector.proposalYield).toBeCloseTo(EMA_OLD_WEIGHT * 2 + (1 - EMA_OLD_WEIGHT) * 6);
  });

  it('applies reclassification only for medium/high confidence', () => {
    const state = makeState([
      makeSector({
        path: 'src/reclass',
        production: true,
        classificationConfidence: 'high',
      }),
    ]);

    recordScanResult(
      state,
      'src/reclass',
      FIXED_CYCLE,
      0,
      { production: false, confidence: 'low' },
      FIXED_NOW,
    );
    expect(state.sectors[0].production).toBe(true);
    expect(state.sectors[0].classificationConfidence).toBe('high');

    recordScanResult(
      state,
      'src/reclass',
      FIXED_CYCLE + 1,
      0,
      { production: false, confidence: 'medium' },
      FIXED_NOW + 1,
    );
    expect(state.sectors[0].production).toBe(false);
    expect(state.sectors[0].classificationConfidence).toBe('medium');
  });
});

describe('recordTicketOutcome deterministic decay', () => {
  it('decays exactly at OUTCOME_DECAY_INTERVAL and not off-boundary', () => {
    const state = makeState([
      makeSector({
        path: 'src/outcomes',
        successCount: 9,
        failureCount: 10,
      }),
    ]);

    recordTicketOutcome(state, 'src/outcomes', true);
    expect(state.sectors[0].successCount).toBe(Math.round(10 * OUTCOME_DECAY_FACTOR));
    expect(state.sectors[0].failureCount).toBe(Math.round(10 * OUTCOME_DECAY_FACTOR));

    recordTicketOutcome(state, 'src/outcomes', false);
    expect(state.sectors[0].successCount).toBe(Math.round(10 * OUTCOME_DECAY_FACTOR));
    expect(state.sectors[0].failureCount).toBe(Math.round(10 * OUTCOME_DECAY_FACTOR) + 1);
  });

  it('updates category stats while tracking outcomes', () => {
    const state = makeState([makeSector({ path: 'src/categories' })]);

    recordTicketOutcome(state, 'src/categories', true, 'security');
    recordTicketOutcome(state, 'src/categories', false, 'security');

    expect(state.sectors[0].categoryStats).toEqual({
      security: { success: 1, failure: 1 },
    });
  });
});

describe('getSectorCategoryAffinity boundary thresholds', () => {
  it('uses strict >0.6 / <0.3 thresholds with minimum attempts', () => {
    const { boost, suppress } = getSectorCategoryAffinity(
      makeSector({
        categoryStats: {
          'boost-boundary': { success: 3, failure: 2 }, // 0.6: no boost
          'boost-above': { success: 2, failure: 1 }, // 0.666: boost
          'suppress-boundary': { success: 3, failure: 7 }, // 0.3: no suppress
          'suppress-below': { success: 0, failure: 3 }, // 0.0: suppress
          'insufficient-attempts': { success: 2, failure: 0 }, // < min attempts
        },
      }),
    );

    expect(AFFINITY_MIN_ATTEMPTS).toBe(3);
    expect(boost).toEqual(['boost-above']);
    expect(suppress).toEqual(['suppress-below']);
  });
});

describe('suggestScopeAdjustment boundary thresholds', () => {
  it('widens only when average yield is strictly below polished threshold', () => {
    const below = makeState([
      makeSector({ path: 'a', proposalYield: POLISHED_YIELD_THRESHOLD - 0.01 }),
      makeSector({ path: 'b', proposalYield: POLISHED_YIELD_THRESHOLD - 0.01 }),
      makeSector({ path: 'c', proposalYield: POLISHED_YIELD_THRESHOLD - 0.01 }),
    ]);
    expect(suggestScopeAdjustment(below)).toBe('widen');

    const atThreshold = makeState([
      makeSector({ path: 'a', proposalYield: POLISHED_YIELD_THRESHOLD }),
      makeSector({ path: 'b', proposalYield: POLISHED_YIELD_THRESHOLD }),
      makeSector({ path: 'c', proposalYield: POLISHED_YIELD_THRESHOLD }),
    ]);
    expect(suggestScopeAdjustment(atThreshold)).toBe('stable');
  });

  it('narrows only when top-3 average is strictly greater than 2x overall average', () => {
    const equalBoundary = makeState([
      makeSector({ path: 'a', proposalYield: 1.0 }),
      makeSector({ path: 'b', proposalYield: 1.0 }),
      makeSector({ path: 'c', proposalYield: 1.0 }),
      makeSector({ path: 'd', proposalYield: 0.25 }),
      makeSector({ path: 'e', proposalYield: 0.25 }),
      makeSector({ path: 'f', proposalYield: 0.25 }),
      makeSector({ path: 'g', proposalYield: 0.25 }),
      makeSector({ path: 'h', proposalYield: 0.25 }),
      makeSector({ path: 'i', proposalYield: 0.25 }),
    ]);
    expect(suggestScopeAdjustment(equalBoundary)).toBe('stable');

    const aboveBoundary = makeState([
      makeSector({ path: 'a', proposalYield: 1.0 }),
      makeSector({ path: 'b', proposalYield: 1.0 }),
      makeSector({ path: 'c', proposalYield: 1.0 }),
      makeSector({ path: 'd', proposalYield: 0.2 }),
      makeSector({ path: 'e', proposalYield: 0.2 }),
      makeSector({ path: 'f', proposalYield: 0.2 }),
      makeSector({ path: 'g', proposalYield: 0.2 }),
      makeSector({ path: 'h', proposalYield: 0.2 }),
      makeSector({ path: 'i', proposalYield: 0.2 }),
    ]);
    expect(suggestScopeAdjustment(aboveBoundary)).toBe('narrow');
  });
});

describe('sanity check', () => {
  it('keeps stable scope when scanned production sectors are fewer than three', () => {
    const state = makeState([
      makeSector({ path: 'a', scanCount: 1 }),
      makeSector({ path: 'b', scanCount: 1 }),
      makeSector({ path: 'non-prod', production: false, scanCount: 1 }),
    ]);
    expect(suggestScopeAdjustment(state)).toBe('stable');
  });

  it('uses OUTCOME_DECAY_INTERVAL constant in tests', () => {
    expect(OUTCOME_DECAY_INTERVAL).toBe(20);
  });
});
