/**
 * Unit tests for pr-outcomes.ts — PR lifecycle tracking and analysis.
 *
 * Exercises:
 * - NDJSON append (appendPrOutcome)
 * - Resolution tracking with time-to-merge (updatePrOutcome)
 * - Reverse-chronological reads with limit (readPrOutcomes)
 * - URL deduplication, merge rate, avg time-to-merge (analyzePrOutcomes)
 * - Edge cases: empty/missing file, malformed lines, missing creation entry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendPrOutcome,
  updatePrOutcome,
  readPrOutcomes,
  analyzePrOutcomes,
} from '../lib/pr-outcomes.js';
import type { PrOutcomeEntry } from '../lib/pr-outcomes.js';

let tmpDir: string;

function outcomesFile(): string {
  return path.join(tmpDir, '.promptwheel', 'pr-outcomes.ndjson');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-outcomes-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<PrOutcomeEntry> = {}): PrOutcomeEntry {
  return {
    ts: 1700000000000,
    prUrl: 'https://github.com/org/repo/pull/1',
    createdAt: 1700000000000,
    outcome: 'open',
    ticketTitle: 'Test ticket',
    ...overrides,
  };
}

describe('appendPrOutcome', () => {
  it('creates .promptwheel directory and file on first write', () => {
    const entry = makeEntry();
    appendPrOutcome(tmpDir, entry);

    expect(fs.existsSync(outcomesFile())).toBe(true);
    const content = fs.readFileSync(outcomesFile(), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(entry);
  });

  it('appends multiple entries as NDJSON lines', () => {
    appendPrOutcome(tmpDir, makeEntry({ prUrl: 'https://github.com/org/repo/pull/1' }));
    appendPrOutcome(tmpDir, makeEntry({ prUrl: 'https://github.com/org/repo/pull/2' }));
    appendPrOutcome(tmpDir, makeEntry({ prUrl: 'https://github.com/org/repo/pull/3' }));

    const content = fs.readFileSync(outcomesFile(), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]).prUrl).toBe('https://github.com/org/repo/pull/2');
  });
});

describe('readPrOutcomes', () => {
  it('returns empty array when file does not exist', () => {
    expect(readPrOutcomes(tmpDir)).toEqual([]);
  });

  it('returns entries in reverse-chronological order', () => {
    appendPrOutcome(tmpDir, makeEntry({ ts: 1000, prUrl: 'https://github.com/org/repo/pull/1' }));
    appendPrOutcome(tmpDir, makeEntry({ ts: 2000, prUrl: 'https://github.com/org/repo/pull/2' }));
    appendPrOutcome(tmpDir, makeEntry({ ts: 3000, prUrl: 'https://github.com/org/repo/pull/3' }));

    const entries = readPrOutcomes(tmpDir);
    expect(entries).toHaveLength(3);
    expect(entries[0].ts).toBe(3000);
    expect(entries[1].ts).toBe(2000);
    expect(entries[2].ts).toBe(1000);
  });

  it('respects the limit parameter', () => {
    appendPrOutcome(tmpDir, makeEntry({ ts: 1000 }));
    appendPrOutcome(tmpDir, makeEntry({ ts: 2000 }));
    appendPrOutcome(tmpDir, makeEntry({ ts: 3000 }));

    const entries = readPrOutcomes(tmpDir, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].ts).toBe(3000);
    expect(entries[1].ts).toBe(2000);
  });

  it('skips malformed NDJSON lines', () => {
    fs.mkdirSync(path.dirname(outcomesFile()), { recursive: true });
    const validEntry = makeEntry();
    fs.writeFileSync(
      outcomesFile(),
      JSON.stringify(validEntry) + '\n' + 'not valid json\n' + JSON.stringify(makeEntry({ ts: 9999 })) + '\n',
      'utf-8',
    );

    const entries = readPrOutcomes(tmpDir);
    expect(entries).toHaveLength(2);
    // Reverse order: ts=9999 first, then ts=1700000000000
    expect(entries[0].ts).toBe(9999);
    expect(entries[1].ts).toBe(validEntry.ts);
  });

  it('handles empty file', () => {
    fs.mkdirSync(path.dirname(outcomesFile()), { recursive: true });
    fs.writeFileSync(outcomesFile(), '', 'utf-8');

    expect(readPrOutcomes(tmpDir)).toEqual([]);
  });
});

describe('updatePrOutcome', () => {
  it('appends a resolution entry with time-to-merge computed from creation', () => {
    const createdAt = 1700000000000;
    const resolvedAt = 1700003600000; // 1 hour later
    const prUrl = 'https://github.com/org/repo/pull/42';

    appendPrOutcome(tmpDir, makeEntry({
      prUrl,
      createdAt,
      outcome: 'open',
      formula: 'test-coverage',
      category: 'test',
      ticketTitle: 'Add tests',
    }));

    updatePrOutcome(tmpDir, prUrl, 'merged', resolvedAt);

    const entries = readPrOutcomes(tmpDir);
    expect(entries).toHaveLength(2);

    const resolution = entries[0]; // Most recent
    expect(resolution.outcome).toBe('merged');
    expect(resolution.prUrl).toBe(prUrl);
    expect(resolution.createdAt).toBe(createdAt);
    expect(resolution.resolvedAt).toBe(resolvedAt);
    expect(resolution.timeToResolveMs).toBe(3600000);
    expect(resolution.formula).toBe('test-coverage');
    expect(resolution.category).toBe('test');
    expect(resolution.ticketTitle).toBe('Add tests');
  });

  it('handles missing creation entry gracefully (uses resolvedAt as createdAt)', () => {
    const resolvedAt = 1700003600000;
    const prUrl = 'https://github.com/org/repo/pull/99';

    updatePrOutcome(tmpDir, prUrl, 'closed', resolvedAt);

    const entries = readPrOutcomes(tmpDir);
    expect(entries).toHaveLength(1);

    const resolution = entries[0];
    expect(resolution.outcome).toBe('closed');
    expect(resolution.createdAt).toBe(resolvedAt);
    expect(resolution.timeToResolveMs).toBe(0);
    expect(resolution.ticketTitle).toBe('');
  });
});

describe('analyzePrOutcomes', () => {
  it('returns zeroed summary when no outcomes exist', () => {
    const summary = analyzePrOutcomes(tmpDir);
    expect(summary).toEqual({
      total: 0,
      merged: 0,
      closed: 0,
      open: 0,
      mergeRate: 0,
      avgTimeToMergeMs: null,
    });
  });

  it('deduplicates by PR URL using the latest entry', () => {
    const prUrl = 'https://github.com/org/repo/pull/1';

    // Open entry
    appendPrOutcome(tmpDir, makeEntry({ ts: 1000, prUrl, outcome: 'open', createdAt: 1000 }));
    // Merged entry (later)
    appendPrOutcome(tmpDir, makeEntry({
      ts: 2000,
      prUrl,
      outcome: 'merged',
      createdAt: 1000,
      resolvedAt: 2000,
      timeToResolveMs: 1000,
    }));

    const summary = analyzePrOutcomes(tmpDir);
    expect(summary.total).toBe(1);
    expect(summary.merged).toBe(1);
    expect(summary.open).toBe(0);
  });

  it('computes merge rate correctly', () => {
    // 2 merged, 1 closed, 1 open
    appendPrOutcome(tmpDir, makeEntry({
      prUrl: 'https://github.com/org/repo/pull/1',
      outcome: 'merged',
      timeToResolveMs: 5000,
    }));
    appendPrOutcome(tmpDir, makeEntry({
      prUrl: 'https://github.com/org/repo/pull/2',
      outcome: 'merged',
      timeToResolveMs: 3000,
    }));
    appendPrOutcome(tmpDir, makeEntry({
      prUrl: 'https://github.com/org/repo/pull/3',
      outcome: 'closed',
    }));
    appendPrOutcome(tmpDir, makeEntry({
      prUrl: 'https://github.com/org/repo/pull/4',
      outcome: 'open',
    }));

    const summary = analyzePrOutcomes(tmpDir);
    expect(summary.total).toBe(4);
    expect(summary.merged).toBe(2);
    expect(summary.closed).toBe(1);
    expect(summary.open).toBe(1);
    // mergeRate = merged / (merged + closed) = 2/3
    expect(summary.mergeRate).toBeCloseTo(2 / 3);
  });

  it('computes average time-to-merge from merged entries only', () => {
    appendPrOutcome(tmpDir, makeEntry({
      prUrl: 'https://github.com/org/repo/pull/1',
      outcome: 'merged',
      timeToResolveMs: 6000,
    }));
    appendPrOutcome(tmpDir, makeEntry({
      prUrl: 'https://github.com/org/repo/pull/2',
      outcome: 'merged',
      timeToResolveMs: 4000,
    }));
    appendPrOutcome(tmpDir, makeEntry({
      prUrl: 'https://github.com/org/repo/pull/3',
      outcome: 'closed',
      timeToResolveMs: 1000,
    }));

    const summary = analyzePrOutcomes(tmpDir);
    expect(summary.avgTimeToMergeMs).toBe(5000); // (6000 + 4000) / 2
  });

  it('returns null avgTimeToMergeMs when no merged PRs have time data', () => {
    appendPrOutcome(tmpDir, makeEntry({
      prUrl: 'https://github.com/org/repo/pull/1',
      outcome: 'open',
    }));

    const summary = analyzePrOutcomes(tmpDir);
    expect(summary.avgTimeToMergeMs).toBeNull();
  });

  it('handles all PRs only open', () => {
    appendPrOutcome(tmpDir, makeEntry({ prUrl: 'https://github.com/org/repo/pull/1', outcome: 'open' }));
    appendPrOutcome(tmpDir, makeEntry({ prUrl: 'https://github.com/org/repo/pull/2', outcome: 'open' }));

    const summary = analyzePrOutcomes(tmpDir);
    expect(summary.total).toBe(2);
    expect(summary.mergeRate).toBe(0); // No resolved PRs
    expect(summary.avgTimeToMergeMs).toBeNull();
  });
});
