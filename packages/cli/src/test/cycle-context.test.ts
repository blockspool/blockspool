import { describe, it, expect } from 'vitest';
import {
  buildCycleContextBlock,
  pushCycleSummary,
  type CycleSummary,
} from '../lib/cycle-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<CycleSummary> = {}): CycleSummary {
  return {
    cycle: 1,
    scope: 'src/**',
    formula: 'default',
    succeeded: [],
    failed: [],
    noChanges: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCycleContextBlock
// ---------------------------------------------------------------------------

describe('buildCycleContextBlock', () => {
  it('returns empty string for empty input', () => {
    expect(buildCycleContextBlock([])).toBe('');
    expect(buildCycleContextBlock([], [])).toBe('');
  });

  it('includes succeeded entries', () => {
    const cycles = [makeSummary({
      cycle: 1,
      succeeded: [{ title: 'Fix auth', category: 'security' }],
    })];
    const result = buildCycleContextBlock(cycles);
    expect(result).toContain('<recent-cycles>');
    expect(result).toContain('</recent-cycles>');
    expect(result).toContain('Cycle 1');
    expect(result).toContain('[security] Fix auth');
    expect(result).toContain('Succeeded:');
  });

  it('includes failed entries', () => {
    const cycles = [makeSummary({
      cycle: 2,
      failed: [{ title: 'Refactor DB', reason: 'timeout' }],
    })];
    const result = buildCycleContextBlock(cycles);
    expect(result).toContain('Failed:');
    expect(result).toContain('Refactor DB (timeout)');
  });

  it('includes noChanges entries', () => {
    const cycles = [makeSummary({
      noChanges: ['Update docs'],
    })];
    const result = buildCycleContextBlock(cycles);
    expect(result).toContain('No changes produced:');
    expect(result).toContain('Update docs');
  });

  it('includes recent diffs section when provided', () => {
    const diffs = [{
      title: 'Fix auth',
      summary: 'Added token validation',
      files: ['src/auth.ts', 'src/middleware.ts'],
      cycle: 1,
    }];
    const result = buildCycleContextBlock([], diffs);
    expect(result).toContain('<recent-diffs>');
    expect(result).toContain('</recent-diffs>');
    expect(result).toContain('Fix auth');
    expect(result).toContain('src/auth.ts, src/middleware.ts');
    expect(result).toContain('Consider proposing follow-up work');
  });

  it('limits recent diffs to last 5', () => {
    const diffs = Array.from({ length: 8 }, (_, i) => ({
      title: `Change ${i}`,
      summary: `Summary ${i}`,
      files: [`file${i}.ts`],
      cycle: i,
    }));
    const result = buildCycleContextBlock([], diffs);
    // Should contain changes 3-7 (last 5) but not 0-2
    expect(result).toContain('Change 3');
    expect(result).toContain('Change 7');
    expect(result).not.toContain('Change 2');
  });

  it('includes follow-up guidance text', () => {
    const cycles = [makeSummary({ succeeded: [{ title: 'X', category: 'fix' }] })];
    const result = buildCycleContextBlock(cycles);
    expect(result).toContain('Use these outcomes to propose FOLLOW-UP work');
    expect(result).toContain('Fix what failed');
  });
});

// ---------------------------------------------------------------------------
// pushCycleSummary
// ---------------------------------------------------------------------------

describe('pushCycleSummary', () => {
  it('appends to empty buffer', () => {
    const result = pushCycleSummary([], makeSummary({ cycle: 1 }));
    expect(result).toHaveLength(1);
    expect(result[0].cycle).toBe(1);
  });

  it('appends within max limit', () => {
    const buf = [makeSummary({ cycle: 1 }), makeSummary({ cycle: 2 })];
    const result = pushCycleSummary(buf, makeSummary({ cycle: 3 }), 5);
    expect(result).toHaveLength(3);
  });

  it('trims oldest when exceeding max', () => {
    const buf = Array.from({ length: 5 }, (_, i) => makeSummary({ cycle: i + 1 }));
    const result = pushCycleSummary(buf, makeSummary({ cycle: 6 }), 5);
    expect(result).toHaveLength(5);
    expect(result[0].cycle).toBe(2); // oldest (cycle 1) trimmed
    expect(result[4].cycle).toBe(6);
  });

  it('uses default max of 5', () => {
    const buf = Array.from({ length: 5 }, (_, i) => makeSummary({ cycle: i + 1 }));
    const result = pushCycleSummary(buf, makeSummary({ cycle: 6 }));
    expect(result).toHaveLength(5);
    expect(result[0].cycle).toBe(2);
  });

  it('handles custom max of 1', () => {
    const buf = [makeSummary({ cycle: 1 })];
    const result = pushCycleSummary(buf, makeSummary({ cycle: 2 }), 1);
    expect(result).toHaveLength(1);
    expect(result[0].cycle).toBe(2);
  });
});

