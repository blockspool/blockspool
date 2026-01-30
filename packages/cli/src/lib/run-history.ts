/**
 * Run History - Audit trail for auto runs
 *
 * Appends a structured summary after each auto run to
 * .blockspool/history.ndjson for post-run analysis.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// =============================================================================
// Types
// =============================================================================

export interface RunHistoryEntry {
  timestamp: string;
  mode: 'auto' | 'manual' | 'ci';
  scope: string;
  formula?: string;
  ticketsProposed: number;
  ticketsApproved: number;
  ticketsCompleted: number;
  ticketsFailed: number;
  prsCreated: number;
  prsMerged: number;
  durationMs: number;
  parallel: number;
  stoppedReason?: string;
  errors?: string[];
  /** Individual ticket outcomes */
  tickets?: TicketOutcome[];
}

export interface TicketOutcome {
  id: string;
  title: string;
  category?: string;
  status: 'completed' | 'failed' | 'spindle_abort' | 'skipped';
  prUrl?: string;
  durationMs?: number;
  error?: string;
}

// =============================================================================
// History File Operations
// =============================================================================

/**
 * Append a run history entry to the NDJSON file
 */
export function appendRunHistory(
  entry: RunHistoryEntry,
  repoPath?: string
): string {
  const dir = path.join(repoPath || process.cwd(), '.blockspool');
  const filePath = path.join(dir, 'history.ndjson');

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(filePath, line, 'utf-8');

  return filePath;
}

/**
 * Read all run history entries
 */
export function readRunHistory(
  repoPath?: string,
  limit?: number
): RunHistoryEntry[] {
  const filePath = path.join(repoPath || process.cwd(), '.blockspool', 'history.ndjson');

  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.length > 0);

  // Most recent first
  const entries: RunHistoryEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      // Skip malformed lines
    }
    if (limit && entries.length >= limit) break;
  }

  return entries;
}

/**
 * Format a history entry for display
 */
export function formatHistoryEntry(entry: RunHistoryEntry): string {
  const date = new Date(entry.timestamp);
  const duration = formatDuration(entry.durationMs);
  const formula = entry.formula ? ` (${entry.formula})` : '';

  const parts = [
    `${date.toLocaleDateString()} ${date.toLocaleTimeString()} | ${entry.mode}${formula}`,
    `  Scope: ${entry.scope} | Duration: ${duration} | Parallel: ${entry.parallel}`,
    `  Tickets: ${entry.ticketsCompleted} completed, ${entry.ticketsFailed} failed (${entry.ticketsProposed} proposed)`,
    `  PRs: ${entry.prsCreated} created, ${entry.prsMerged} merged`,
  ];

  if (entry.stoppedReason) {
    parts.push(`  Stopped: ${entry.stoppedReason}`);
  }

  if (entry.errors?.length) {
    parts.push(`  Errors: ${entry.errors.length}`);
  }

  return parts.join('\n');
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
