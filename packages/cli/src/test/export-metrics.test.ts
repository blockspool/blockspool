import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendRunHistory, readRunHistory, type RunHistoryEntry } from '../lib/run-history.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-metrics-test-'));
  fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<RunHistoryEntry> = {}): RunHistoryEntry {
  return {
    timestamp: new Date().toISOString(),
    mode: 'auto',
    scope: 'src',
    ticketsProposed: 5,
    ticketsApproved: 3,
    ticketsCompleted: 2,
    ticketsFailed: 1,
    prsCreated: 2,
    prsMerged: 1,
    durationMs: 60000,
    parallel: 2,
    ...overrides,
  };
}

describe('run history NDJSON format', () => {
  it('appendRunHistory writes valid NDJSON', () => {
    const entry = makeEntry({ formula: 'security-audit' });
    appendRunHistory(entry, tmpDir);
    appendRunHistory(makeEntry({ formula: 'test-coverage' }), tmpDir);

    const filePath = path.join(tmpDir, '.promptwheel', 'history.ndjson');
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(2);

    // Each line should be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('mode');
      expect(parsed).toHaveProperty('ticketsCompleted');
    }

    expect(JSON.parse(lines[0]).formula).toBe('security-audit');
    expect(JSON.parse(lines[1]).formula).toBe('test-coverage');
  });

  it('readRunHistory returns most recent first', () => {
    appendRunHistory(makeEntry({ formula: 'first' }), tmpDir);
    appendRunHistory(makeEntry({ formula: 'second' }), tmpDir);
    appendRunHistory(makeEntry({ formula: 'third' }), tmpDir);

    const entries = readRunHistory(tmpDir);
    expect(entries[0].formula).toBe('third');
    expect(entries[2].formula).toBe('first');
  });

  it('readRunHistory respects limit', () => {
    for (let i = 0; i < 10; i++) {
      appendRunHistory(makeEntry({ formula: `run-${i}` }), tmpDir);
    }

    const entries = readRunHistory(tmpDir, 3);
    expect(entries).toHaveLength(3);
    expect(entries[0].formula).toBe('run-9');
  });

  it('includes phaseTiming when present', () => {
    const entry = makeEntry({
      phaseTiming: {
        totalScoutMs: 1000,
        totalExecuteMs: 5000,
        totalQaMs: 2000,
        totalGitMs: 500,
      },
    });
    appendRunHistory(entry, tmpDir);

    const entries = readRunHistory(tmpDir);
    expect(entries[0].phaseTiming).toEqual({
      totalScoutMs: 1000,
      totalExecuteMs: 5000,
      totalQaMs: 2000,
      totalGitMs: 500,
    });
  });

  it('includes tokenUsage when present', () => {
    const entry = makeEntry({
      tokenUsage: {
        totalInputTokens: 50000,
        totalOutputTokens: 10000,
        totalCostUsd: 0.25,
      },
    });
    appendRunHistory(entry, tmpDir);

    const entries = readRunHistory(tmpDir);
    expect(entries[0].tokenUsage).toEqual({
      totalInputTokens: 50000,
      totalOutputTokens: 10000,
      totalCostUsd: 0.25,
    });
  });

  it('includes drillStats when present', () => {
    const entry = makeEntry({
      drillStats: {
        trajectoriesGenerated: 2,
        stepsCompleted: 5,
        stepsFailed: 1,
        stepsTotal: 8,
        completionRate: 0.625,
      },
    });
    appendRunHistory(entry, tmpDir);

    const entries = readRunHistory(tmpDir);
    expect(entries[0].drillStats).toEqual({
      trajectoriesGenerated: 2,
      stepsCompleted: 5,
      stepsFailed: 1,
      stepsTotal: 8,
      completionRate: 0.625,
    });
  });

  it('includes ticket-level outcomes', () => {
    const entry = makeEntry({
      tickets: [
        { id: 'tkt_1', title: 'Fix auth', status: 'completed', category: 'fix', prUrl: 'https://...' },
        { id: 'tkt_2', title: 'Add test', status: 'failed', category: 'test', failureReason: 'qa_failed' },
      ],
    });
    appendRunHistory(entry, tmpDir);

    const entries = readRunHistory(tmpDir);
    expect(entries[0].tickets).toHaveLength(2);
    expect(entries[0].tickets![0].status).toBe('completed');
    expect(entries[0].tickets![1].failureReason).toBe('qa_failed');
  });

  it('handles empty history gracefully', () => {
    const entries = readRunHistory(tmpDir);
    expect(entries).toEqual([]);
  });

  it('skips malformed lines', () => {
    const filePath = path.join(tmpDir, '.promptwheel', 'history.ndjson');
    fs.writeFileSync(filePath, JSON.stringify(makeEntry({ formula: 'good' })) + '\nnot-json\n');

    const entries = readRunHistory(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].formula).toBe('good');
  });
});
