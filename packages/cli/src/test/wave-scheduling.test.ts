/**
 * Tests for conflict-aware wave scheduling
 */

import { describe, it, expect } from 'vitest';
import { partitionIntoWaves } from '../lib/solo-auto.js';

type Proposal = { title: string; files: string[] };

describe('partitionIntoWaves', () => {
  it('puts non-overlapping proposals in the same wave', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/a.ts'] },
      { title: 'B', files: ['src/b.ts'] },
      { title: 'C', files: ['src/c.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it('separates proposals with overlapping files into different waves', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/utils.ts'] },
      { title: 'B', files: ['src/utils.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(1);
    expect(waves[1]).toHaveLength(1);
    expect(waves[0][0].title).toBe('A');
    expect(waves[1][0].title).toBe('B');
  });

  it('separates proposals with directory containment overlap', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/lib/utils.ts'] },
      { title: 'B', files: ['src/lib/helpers.ts'] },
      { title: 'C', files: ['src/lib/utils.ts', 'src/lib/types.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    // A and C overlap on src/lib/utils.ts, so they must be in different waves
    // B doesn't overlap with either
    expect(waves.length).toBeGreaterThanOrEqual(2);

    // A and C should not be in the same wave
    for (const wave of waves) {
      const titles = wave.map(p => p.title);
      expect(titles.includes('A') && titles.includes('C')).toBe(false);
    }
  });

  it('handles glob pattern overlaps', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/lib/**'] },
      { title: 'B', files: ['src/lib/utils.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    expect(waves).toHaveLength(2);
  });

  it('returns single wave for single proposal', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/a.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(1);
  });

  it('returns empty for empty input', () => {
    const waves = partitionIntoWaves([]);

    expect(waves).toHaveLength(0);
  });

  it('creates multiple waves for chain of conflicts', () => {
    // A overlaps B, B overlaps C, but A doesn't overlap C
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/a.ts', 'src/shared.ts'] },
      { title: 'B', files: ['src/shared.ts', 'src/other.ts'] },
      { title: 'C', files: ['src/c.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    // A and B conflict, C is independent
    // A goes to wave 0, B to wave 1, C to wave 0
    expect(waves).toHaveLength(2);

    const wave0Titles = waves[0].map(p => p.title);
    expect(wave0Titles).toContain('A');
    expect(wave0Titles).toContain('C');
    expect(wave0Titles).not.toContain('B');
  });

  it('handles proposals with multiple files each', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/a.ts', 'src/b.ts'] },
      { title: 'B', files: ['src/c.ts', 'src/d.ts'] },
      { title: 'C', files: ['src/b.ts', 'src/e.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    // A and C overlap on src/b.ts
    expect(waves.length).toBeGreaterThanOrEqual(2);

    for (const wave of waves) {
      const titles = wave.map(p => p.title);
      expect(titles.includes('A') && titles.includes('C')).toBe(false);
    }
  });

  it('handles proposals with empty files arrays', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: [] },
      { title: 'B', files: [] },
      { title: 'C', files: ['src/c.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    // Empty files don't overlap with anything
    expect(waves).toHaveLength(1);
  });
});
