import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendRunHistory,
  readRunHistory,
  type RunHistoryEntry,
} from '../lib/run-history.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function historyFile(): string {
  return path.join(tmpDir, '.blockspool', 'history.ndjson');
}

function makeEntry(overrides: Partial<RunHistoryEntry> = {}): RunHistoryEntry {
  return {
    timestamp: new Date().toISOString(),
    mode: 'auto',
    scope: '**',
    ticketsProposed: 5,
    ticketsApproved: 4,
    ticketsCompleted: 3,
    ticketsFailed: 1,
    prsCreated: 3,
    prsMerged: 2,
    durationMs: 60000,
    parallel: 2,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-test-'));
  fs.mkdirSync(path.join(tmpDir, '.blockspool'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// appendRunHistory
// ---------------------------------------------------------------------------

describe('appendRunHistory', () => {
  it('creates file and returns file path', () => {
    const entry = makeEntry();
    const filePath = appendRunHistory(entry, tmpDir);

    expect(filePath).toBe(historyFile());
    expect(fs.existsSync(historyFile())).toBe(true);

    const content = fs.readFileSync(historyFile(), 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.mode).toBe('auto');
  });

  it('appends to existing file', () => {
    const entry1 = makeEntry({ mode: 'auto', scope: 'src/**' });
    const entry2 = makeEntry({ mode: 'ci', scope: 'tests/**' });

    appendRunHistory(entry1, tmpDir);
    appendRunHistory(entry2, tmpDir);

    const lines = fs.readFileSync(historyFile(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]);
    const parsed2 = JSON.parse(lines[1]);
    expect(parsed1.mode).toBe('auto');
    expect(parsed1.scope).toBe('src/**');
    expect(parsed2.mode).toBe('ci');
    expect(parsed2.scope).toBe('tests/**');
  });
});

// ---------------------------------------------------------------------------
// readRunHistory
// ---------------------------------------------------------------------------

describe('readRunHistory', () => {
  it('returns entries most-recent-first', () => {
    const entry1 = makeEntry({ timestamp: '2024-01-01T00:00:00.000Z', scope: 'first' });
    const entry2 = makeEntry({ timestamp: '2024-01-02T00:00:00.000Z', scope: 'second' });
    const entry3 = makeEntry({ timestamp: '2024-01-03T00:00:00.000Z', scope: 'third' });

    appendRunHistory(entry1, tmpDir);
    appendRunHistory(entry2, tmpDir);
    appendRunHistory(entry3, tmpDir);

    const entries = readRunHistory(tmpDir);
    expect(entries).toHaveLength(3);
    expect(entries[0].scope).toBe('third');
    expect(entries[1].scope).toBe('second');
    expect(entries[2].scope).toBe('first');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      appendRunHistory(makeEntry({ scope: `scope-${i}` }), tmpDir);
    }

    const entries = readRunHistory(tmpDir, 3);
    expect(entries).toHaveLength(3);
    // Most recent first, so scope-4, scope-3, scope-2
    expect(entries[0].scope).toBe('scope-4');
    expect(entries[1].scope).toBe('scope-3');
    expect(entries[2].scope).toBe('scope-2');
  });

  it('handles malformed lines gracefully', () => {
    // Write a mix of garbage and valid JSON directly to the file
    const validEntry = makeEntry({ scope: 'valid-entry' });
    const content = [
      'this is not json',
      JSON.stringify(validEntry),
      '{broken json{{{',
      JSON.stringify(makeEntry({ scope: 'another-valid' })),
      '',
    ].join('\n');

    fs.writeFileSync(historyFile(), content, 'utf-8');

    const entries = readRunHistory(tmpDir);
    expect(entries).toHaveLength(2);
    // Most recent first (last valid line first)
    expect(entries[0].scope).toBe('another-valid');
    expect(entries[1].scope).toBe('valid-entry');
  });

  it('returns empty array for missing file', () => {
    // Remove the .blockspool dir so history file does not exist
    fs.rmSync(path.join(tmpDir, '.blockspool'), { recursive: true, force: true });

    const entries = readRunHistory(tmpDir);
    expect(entries).toEqual([]);
  });

  it('returns empty array from non-existent repo path', () => {
    const nonExistentPath = path.join(os.tmpdir(), 'non-existent-repo-' + Date.now());
    const entries = readRunHistory(nonExistentPath);
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: specific fields
// ---------------------------------------------------------------------------

describe('round-trip field correctness', () => {
  it('preserves all fields through append and read', () => {
    const entry: RunHistoryEntry = {
      timestamp: '2024-06-15T12:30:00.000Z',
      mode: 'manual',
      scope: 'packages/cli/**',
      formula: 'security-audit',
      ticketsProposed: 10,
      ticketsApproved: 8,
      ticketsCompleted: 6,
      ticketsFailed: 2,
      prsCreated: 5,
      prsMerged: 4,
      durationMs: 120000,
      parallel: 3,
      stoppedReason: 'budget_exhausted',
      errors: ['lint failed', 'type error in foo.ts'],
      tickets: [
        {
          id: 'tkt-abc',
          title: 'Fix auth bug',
          category: 'bug',
          status: 'completed',
          prUrl: 'https://github.com/org/repo/pull/42',
          durationMs: 30000,
        },
        {
          id: 'tkt-def',
          title: 'Add tests',
          status: 'failed',
          error: 'timeout',
          durationMs: 60000,
        },
      ],
    };

    appendRunHistory(entry, tmpDir);
    const entries = readRunHistory(tmpDir);

    expect(entries).toHaveLength(1);
    const result = entries[0];

    expect(result.timestamp).toBe('2024-06-15T12:30:00.000Z');
    expect(result.mode).toBe('manual');
    expect(result.scope).toBe('packages/cli/**');
    expect(result.formula).toBe('security-audit');
    expect(result.ticketsProposed).toBe(10);
    expect(result.ticketsApproved).toBe(8);
    expect(result.ticketsCompleted).toBe(6);
    expect(result.ticketsFailed).toBe(2);
    expect(result.prsCreated).toBe(5);
    expect(result.prsMerged).toBe(4);
    expect(result.durationMs).toBe(120000);
    expect(result.parallel).toBe(3);
    expect(result.stoppedReason).toBe('budget_exhausted');
    expect(result.errors).toEqual(['lint failed', 'type error in foo.ts']);
    expect(result.tickets).toHaveLength(2);
    expect(result.tickets![0].id).toBe('tkt-abc');
    expect(result.tickets![0].title).toBe('Fix auth bug');
    expect(result.tickets![0].category).toBe('bug');
    expect(result.tickets![0].status).toBe('completed');
    expect(result.tickets![0].prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(result.tickets![1].id).toBe('tkt-def');
    expect(result.tickets![1].status).toBe('failed');
    expect(result.tickets![1].error).toBe('timeout');
  });
});
