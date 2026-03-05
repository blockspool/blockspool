/**
 * Tests for the session journal — packages/mcp/src/journal.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendJournalEntry,
  journalSessionStart,
  journalScoutComplete,
  journalTicketStart,
  journalTicketComplete,
  journalTicketFailed,
  journalSessionEnd,
} from '../journal.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-journal-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readJournal(): string {
  return fs.readFileSync(path.join(tmpDir, 'journal.md'), 'utf8');
}

// ---------------------------------------------------------------------------
// appendJournalEntry
// ---------------------------------------------------------------------------

describe('appendJournalEntry', () => {
  it('creates journal.md if it does not exist', () => {
    appendJournalEntry(tmpDir, { type: 'session_start', content: '## Test' });
    expect(fs.existsSync(path.join(tmpDir, 'journal.md'))).toBe(true);
    expect(readJournal()).toContain('## Test');
  });

  it('appends multiple entries', () => {
    appendJournalEntry(tmpDir, { type: 'session_start', content: 'Entry 1' });
    appendJournalEntry(tmpDir, { type: 'scout_complete', content: 'Entry 2' });
    const content = readJournal();
    expect(content).toContain('Entry 1');
    expect(content).toContain('Entry 2');
  });

  it('does not throw on invalid directory', () => {
    expect(() => {
      appendJournalEntry('/nonexistent/path/xyz', { type: 'session_start', content: 'nope' });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Journal entry formatters
// ---------------------------------------------------------------------------

describe('journalSessionStart', () => {
  it('includes session timestamp', () => {
    const entry = journalSessionStart({
      scope: 'src/**',
      categories: ['fix', 'refactor'],
      stepBudget: 200,
      startedAt: '2024-03-04T10:30:00Z',
    });
    expect(entry.type).toBe('session_start');
    expect(entry.content).toContain('2024-03-04T10:30:00Z');
    expect(entry.content).toContain('scope=src/**');
    expect(entry.content).toContain('fix,refactor');
    expect(entry.content).toContain('200 steps');
  });
});

describe('journalScoutComplete', () => {
  it('formats scout results with titles', () => {
    const entry = journalScoutComplete({
      cycleNumber: 1,
      found: 5,
      accepted: 3,
      rejected: 2,
      acceptedTitles: ['Fix auth', 'Add types', 'Refactor logger'],
    });
    expect(entry.type).toBe('scout_complete');
    expect(entry.content).toContain('Scout Cycle 1');
    expect(entry.content).toContain('5 proposals');
    expect(entry.content).toContain('3 accepted');
    expect(entry.content).toContain('2 rejected');
    expect(entry.content).toContain('Fix auth');
  });

  it('handles empty accepted titles', () => {
    const entry = journalScoutComplete({
      cycleNumber: 2,
      found: 3,
      accepted: 0,
      rejected: 3,
      acceptedTitles: [],
    });
    expect(entry.content).toContain('0 accepted');
    expect(entry.content).not.toContain('Accepted:');
  });
});

describe('journalTicketStart', () => {
  it('includes ticket id and title', () => {
    const entry = journalTicketStart('tkt_123', 'Fix null check');
    expect(entry.type).toBe('ticket_start');
    expect(entry.content).toContain('Fix null check');
    expect(entry.content).toContain('tkt_123');
  });
});

describe('journalTicketComplete', () => {
  it('formats completion with files and cost', () => {
    const entry = journalTicketComplete({
      title: 'Fix null check',
      changedFiles: ['src/auth.ts', 'src/auth.test.ts'],
      linesChanged: 12,
      costUsd: 0.0312,
    });
    expect(entry.type).toBe('ticket_complete');
    expect(entry.content).toContain('completed');
    expect(entry.content).toContain('src/auth.ts');
    expect(entry.content).toContain('12 lines');
    expect(entry.content).toContain('$0.0312');
  });

  it('omits cost when undefined', () => {
    const entry = journalTicketComplete({
      title: 'Refactor',
      changedFiles: ['src/utils.ts'],
      linesChanged: 5,
    });
    expect(entry.content).not.toContain('Cost:');
  });

  it('handles empty changed files', () => {
    const entry = journalTicketComplete({
      title: 'No-op',
      changedFiles: [],
      linesChanged: 0,
    });
    expect(entry.content).toContain('No file changes');
  });
});

describe('journalTicketFailed', () => {
  it('includes title and reason', () => {
    const entry = journalTicketFailed('Broken ticket', 'Tests failed');
    expect(entry.type).toBe('ticket_failed');
    expect(entry.content).toContain('failed');
    expect(entry.content).toContain('Tests failed');
  });

  it('truncates long reasons', () => {
    const longReason = 'x'.repeat(500);
    const entry = journalTicketFailed('Long fail', longReason);
    expect(entry.content.length).toBeLessThan(400);
  });
});

describe('journalSessionEnd', () => {
  it('formats session summary', () => {
    const entry = journalSessionEnd({
      ticketsCompleted: 3,
      ticketsFailed: 1,
      totalCostUsd: 0.09,
      durationMs: 750_000, // 12m 30s
    });
    expect(entry.type).toBe('session_end');
    expect(entry.content).toContain('3 tickets completed');
    expect(entry.content).toContain('1 failed');
    expect(entry.content).toContain('$0.0900');
    expect(entry.content).toContain('12m 30s');
  });

  it('omits cost when zero', () => {
    const entry = journalSessionEnd({
      ticketsCompleted: 1,
      ticketsFailed: 0,
      totalCostUsd: 0,
      durationMs: 60_000,
    });
    expect(entry.content).not.toContain('Total cost');
  });
});
