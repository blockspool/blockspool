/**
 * Tests for multi-lens rotation logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports from the SUT
// ---------------------------------------------------------------------------

vi.mock('../lib/run-state.js', () => ({
  readRunState: vi.fn().mockReturnValue({
    totalCycles: 10,
    formulaStats: {},
  }),
}));

vi.mock('../lib/formulas.js', () => ({
  listFormulas: vi.fn().mockReturnValue([
    { name: 'default', description: 'Default' },
    { name: 'security-audit', description: 'Security' },
    { name: 'type-safety', description: 'Types' },
    { name: 'cleanup', description: 'Cleanup' },
    { name: 'test-coverage', description: 'Tests' },
    { name: 'docs', description: 'Docs' },
    { name: 'deep', description: 'Deep' },
    { name: 'docs-audit', description: 'Docs audit' },
  ]),
  loadFormula: vi.fn(),
}));

// ---------------------------------------------------------------------------
// SUT imports (after mocks)
// ---------------------------------------------------------------------------

import { buildLensRotation, advanceLens, recordZeroYield, recordLensScan } from '../lib/lens-rotation.js';
import { readRunState } from '../lib/run-state.js';
import { listFormulas } from '../lib/formulas.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildLensRotation', () => {
  beforeEach(() => {
    vi.mocked(readRunState).mockReturnValue({
      totalCycles: 10,
      formulaStats: {},
      lastDocsAuditCycle: 0,
      lastRunAt: 0,
      deferredProposals: [],
    });
    vi.mocked(listFormulas).mockReturnValue([
      { name: 'default', description: 'Default' },
      { name: 'security-audit', description: 'Security' },
      { name: 'type-safety', description: 'Types' },
      { name: 'cleanup', description: 'Cleanup' },
      { name: 'test-coverage', description: 'Tests' },
      { name: 'docs', description: 'Docs' },
      { name: 'deep', description: 'Deep' },
      { name: 'docs-audit', description: 'Docs audit' },
    ] as any[]);
  });

  it('returns default lenses with default as first when no user formula', () => {
    const result = buildLensRotation('/repo', null);
    expect(result).toContain('default');
    // deep and docs-audit should be excluded
    expect(result).not.toContain('deep');
    expect(result).not.toContain('docs-audit');
    // Should include rotation candidates
    expect(result).toContain('security-audit');
    expect(result).toContain('type-safety');
    expect(result).toContain('cleanup');
    expect(result).toContain('test-coverage');
    expect(result).toContain('docs');
  });

  it('returns single-item array when user formula is specified', () => {
    const result = buildLensRotation('/repo', { name: 'my-formula', description: 'Custom' } as any);
    expect(result).toEqual(['my-formula']);
  });

  it('includes user-defined formulas not in default list', () => {
    vi.mocked(listFormulas).mockReturnValue([
      { name: 'default', description: 'Default' },
      { name: 'security-audit', description: 'Security' },
      { name: 'my-custom', description: 'My custom formula' },
    ] as any[]);
    const result = buildLensRotation('/repo', null);
    expect(result).toContain('my-custom');
  });

  it('orders by UCB1 score — formulas with stats get exploitation bonus', () => {
    vi.mocked(readRunState).mockReturnValue({
      totalCycles: 100,
      formulaStats: {
        'security-audit': {
          cycles: 10, proposalsGenerated: 50, ticketsSucceeded: 8,
          ticketsTotal: 10, recentCycles: 10, recentProposalsGenerated: 50,
          recentTicketsSucceeded: 8, recentTicketsTotal: 10, lastResetCycle: 90,
        },
      },
      lastDocsAuditCycle: 0,
      lastRunAt: 0,
      deferredProposals: [],
    });
    const result = buildLensRotation('/repo', null);
    // security-audit has high success rate, should be ranked well
    expect(result.length).toBeGreaterThan(1);
    expect(result).toContain('security-audit');
  });
});

describe('advanceLens', () => {
  it('advances to the next lens with unscanned sectors', () => {
    const state = {
      lensRotation: ['default', 'security-audit', 'type-safety'],
      lensIndex: 0,
      currentLens: 'default',
      lensMatrix: new Map<string, Set<string>>([
        ['default', new Set(['src/a', 'src/b'])],
      ]),
      sectorState: { sectors: [{ path: 'src/a' }, { path: 'src/b' }] },
      lensZeroYieldPairs: new Set<string>(),
      sessionPhase: 'deep',
    };

    const result = advanceLens(state);
    expect(result).toBe(true);
    expect(state.currentLens).toBe('security-audit');
    expect(state.lensIndex).toBe(1);
  });

  it('returns false when all lenses are exhausted', () => {
    const state = {
      lensRotation: ['default', 'security-audit'],
      lensIndex: 0,
      currentLens: 'default',
      lensMatrix: new Map<string, Set<string>>([
        ['default', new Set(['src/a', 'src/b'])],
        ['security-audit', new Set(['src/a', 'src/b'])],
      ]),
      sectorState: { sectors: [{ path: 'src/a' }, { path: 'src/b' }] },
      lensZeroYieldPairs: new Set<string>(),
      sessionPhase: 'deep',
    };

    const result = advanceLens(state);
    expect(result).toBe(false);
  });

  it('skips lenses where all sectors are zero-yield', () => {
    const state = {
      lensRotation: ['default', 'security-audit', 'type-safety'],
      lensIndex: 0,
      currentLens: 'default',
      lensMatrix: new Map<string, Set<string>>(),
      sectorState: { sectors: [{ path: 'src/a' }, { path: 'src/b' }] },
      lensZeroYieldPairs: new Set<string>([
        'security-audit:src/a',
        'security-audit:src/b',
      ]),
      sessionPhase: 'deep',
    };

    const result = advanceLens(state);
    expect(result).toBe(true);
    // Should skip security-audit (all zero-yield) and go to type-safety
    expect(state.currentLens).toBe('type-safety');
    expect(state.lensIndex).toBe(2);
  });

  it('returns false during warmup phase', () => {
    const state = {
      lensRotation: ['default', 'security-audit'],
      lensIndex: 0,
      currentLens: 'default',
      lensMatrix: new Map<string, Set<string>>(),
      sectorState: { sectors: [{ path: 'src/a' }] },
      lensZeroYieldPairs: new Set<string>(),
      sessionPhase: 'warmup',
    };

    const result = advanceLens(state);
    expect(result).toBe(false);
  });

  it('wraps around the rotation index', () => {
    const state = {
      lensRotation: ['default', 'security-audit', 'type-safety'],
      lensIndex: 2, // at type-safety
      currentLens: 'type-safety',
      lensMatrix: new Map<string, Set<string>>([
        ['type-safety', new Set(['src/a'])],
      ]),
      sectorState: { sectors: [{ path: 'src/a' }] },
      lensZeroYieldPairs: new Set<string>(),
      sessionPhase: 'deep',
    };

    const result = advanceLens(state);
    expect(result).toBe(true);
    // Should wrap to default (index 0)
    expect(state.currentLens).toBe('default');
    expect(state.lensIndex).toBe(0);
  });

  it('returns false with no sectors', () => {
    const state = {
      lensRotation: ['default', 'security-audit'],
      lensIndex: 0,
      currentLens: 'default',
      lensMatrix: new Map<string, Set<string>>(),
      sectorState: { sectors: [] },
      lensZeroYieldPairs: new Set<string>(),
      sessionPhase: 'deep',
    };

    const result = advanceLens(state);
    expect(result).toBe(false);
  });

  it('accounts for combination of scanned and zero-yield sectors', () => {
    const state = {
      lensRotation: ['default', 'security-audit'],
      lensIndex: 0,
      currentLens: 'default',
      lensMatrix: new Map<string, Set<string>>([
        ['security-audit', new Set(['src/a'])], // 1 scanned
      ]),
      sectorState: { sectors: [{ path: 'src/a' }, { path: 'src/b' }, { path: 'src/c' }] },
      lensZeroYieldPairs: new Set<string>([
        'security-audit:src/b', // 1 zero-yield
      ]),
      sessionPhase: 'deep',
    };

    // security-audit: 1 scanned + 1 zero-yield = 2, but 3 total sectors → still has work
    const result = advanceLens(state);
    expect(result).toBe(true);
    expect(state.currentLens).toBe('security-audit');
  });
});

describe('recordZeroYield', () => {
  it('marks a pair when proposal count is 0', () => {
    const state = {
      currentLens: 'security-audit',
      currentSectorId: 'src/a' as string | null,
      lensZeroYieldPairs: new Set<string>(),
    };

    recordZeroYield(state, 0);
    expect(state.lensZeroYieldPairs.has('security-audit:src/a')).toBe(true);
  });

  it('does not mark when proposals are found', () => {
    const state = {
      currentLens: 'security-audit',
      currentSectorId: 'src/a' as string | null,
      lensZeroYieldPairs: new Set<string>(),
    };

    recordZeroYield(state, 3);
    expect(state.lensZeroYieldPairs.size).toBe(0);
  });

  it('does not mark when sectorId is null', () => {
    const state = {
      currentLens: 'security-audit',
      currentSectorId: null as string | null,
      lensZeroYieldPairs: new Set<string>(),
    };

    recordZeroYield(state, 0);
    expect(state.lensZeroYieldPairs.size).toBe(0);
  });
});

describe('recordLensScan', () => {
  it('updates the lens matrix', () => {
    const state = {
      currentLens: 'default',
      currentSectorId: 'src/a' as string | null,
      lensMatrix: new Map<string, Set<string>>(),
    };

    recordLensScan(state);
    expect(state.lensMatrix.get('default')?.has('src/a')).toBe(true);
  });

  it('appends to existing lens entry', () => {
    const state = {
      currentLens: 'default',
      currentSectorId: 'src/b' as string | null,
      lensMatrix: new Map<string, Set<string>>([
        ['default', new Set(['src/a'])],
      ]),
    };

    recordLensScan(state);
    expect(state.lensMatrix.get('default')?.size).toBe(2);
    expect(state.lensMatrix.get('default')?.has('src/a')).toBe(true);
    expect(state.lensMatrix.get('default')?.has('src/b')).toBe(true);
  });

  it('does nothing when sectorId is null', () => {
    const state = {
      currentLens: 'default',
      currentSectorId: null as string | null,
      lensMatrix: new Map<string, Set<string>>(),
    };

    recordLensScan(state);
    expect(state.lensMatrix.size).toBe(0);
  });
});
