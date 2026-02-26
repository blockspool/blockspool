/**
 * Persistent error log for post-session analysis.
 *
 * Stores classified ticket failures in `.promptwheel/error-ledger.ndjson`
 * so error patterns survive across sessions and can be surfaced by analytics.
 */

import * as path from 'node:path';
import type { FailureType } from './failure-classifier.js';
import { appendNdjsonState, readNdjsonState } from './goals.js';

export interface ErrorLedgerEntry {
  ts: number;
  ticketId: string;
  ticketTitle: string;
  failureType: FailureType;
  failedCommand: string;
  errorPattern: string;
  errorMessage: string;
  category?: string;
  phase: 'scout' | 'execute' | 'qa' | 'git' | 'pr';
  sessionCycle: number;
  formula?: string;
}

export interface ErrorPatternSummary {
  failureType: FailureType;
  failedCommand: string;
  count: number;
  lastSeen: number;
}

const LEDGER_FILE = 'error-ledger.ndjson';

function ledgerPath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', LEDGER_FILE);
}

/**
 * Append an error entry to the ledger. Lazily creates the file on first write.
 */
export function appendErrorLedger(repoRoot: string, entry: ErrorLedgerEntry): void {
  appendNdjsonState(ledgerPath(repoRoot), entry);
}

/**
 * Read error ledger entries, most recent first.
 */
export function readErrorLedger(repoRoot: string, limit?: number): ErrorLedgerEntry[] {
  return readNdjsonState<ErrorLedgerEntry>(ledgerPath(repoRoot), {
    newestFirst: true,
    limit,
  });
}

/**
 * Analyze error ledger: group by failureType + failedCommand, return top patterns with counts.
 */
export function analyzeErrorLedger(repoRoot: string, sinceMs?: number): ErrorPatternSummary[] {
  const entries = readErrorLedger(repoRoot);
  const cutoff = sinceMs ?? Date.now() - 30 * 24 * 60 * 60 * 1000; // default: last 30 days

  const grouped = new Map<string, ErrorPatternSummary>();

  for (const entry of entries) {
    if (entry.ts < cutoff) continue;
    const key = `${entry.failureType}::${entry.failedCommand}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count++;
      existing.lastSeen = Math.max(existing.lastSeen, entry.ts);
    } else {
      grouped.set(key, {
        failureType: entry.failureType,
        failedCommand: entry.failedCommand,
        count: 1,
        lastSeen: entry.ts,
      });
    }
  }

  return [...grouped.values()].sort((a, b) => b.count - a.count);
}
