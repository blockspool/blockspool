/**
 * Session journal — append-only markdown log of session events.
 *
 * Writes to `{runDir}/journal.md`. Each entry is a markdown section
 * appended incrementally. Provides a single, human-readable record of
 * what happened during a session.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type JournalEntryType =
  | 'session_start'
  | 'scout_complete'
  | 'ticket_start'
  | 'ticket_complete'
  | 'ticket_failed'
  | 'session_end';

export interface JournalEntry {
  type: JournalEntryType;
  content: string;
}

export function appendJournalEntry(runDir: string, entry: JournalEntry): void {
  const journalPath = path.join(runDir, 'journal.md');
  try {
    fs.appendFileSync(journalPath, entry.content + '\n\n');
  } catch (err) {
    console.warn(`[promptwheel] journal write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function journalSessionStart(config: {
  scope: string;
  categories: string[];
  stepBudget: number;
  startedAt: string;
}): JournalEntry {
  return {
    type: 'session_start',
    content: [
      `## Session ${config.startedAt}`,
      '',
      `**Config:** scope=${config.scope}, categories=${config.categories.join(',')}, budget=${config.stepBudget} steps`,
    ].join('\n'),
  };
}

export function journalScoutComplete(data: {
  cycleNumber: number;
  found: number;
  accepted: number;
  rejected: number;
  acceptedTitles: string[];
}): JournalEntry {
  const titleLines = data.acceptedTitles.map(t => `- "${t}"`).join('\n');
  return {
    type: 'scout_complete',
    content: [
      `### Scout Cycle ${data.cycleNumber}`,
      `- Found ${data.found} proposals, ${data.accepted} accepted, ${data.rejected} rejected`,
      ...(data.acceptedTitles.length > 0 ? [`- Accepted:`, titleLines] : []),
    ].join('\n'),
  };
}

export function journalTicketStart(ticketId: string, title: string): JournalEntry {
  return {
    type: 'ticket_start',
    content: `### Ticket: ${title}\n- ID: ${ticketId}`,
  };
}

export function journalTicketComplete(data: {
  title: string;
  changedFiles: string[];
  linesChanged: number;
  costUsd?: number;
}): JournalEntry {
  const fileSummary = data.changedFiles.length > 0
    ? `Files: ${data.changedFiles.join(', ')} (${data.linesChanged} lines changed)`
    : 'No file changes recorded';
  const costLine = data.costUsd !== undefined && data.costUsd !== null ? `\n- Cost: $${data.costUsd.toFixed(4)}` : '';
  return {
    type: 'ticket_complete',
    content: `- Status: **completed**\n- ${fileSummary}${costLine}`,
  };
}

export function journalTicketFailed(title: string, reason: string): JournalEntry {
  return {
    type: 'ticket_failed',
    content: `- Status: **failed**\n- Reason: ${reason.slice(0, 200)}`,
  };
}

export function journalSessionEnd(data: {
  ticketsCompleted: number;
  ticketsFailed: number;
  totalCostUsd: number;
  durationMs: number;
}): JournalEntry {
  const duration = formatDuration(data.durationMs);
  const costLine = data.totalCostUsd > 0 ? `\n- Total cost: $${data.totalCostUsd.toFixed(4)}` : '';
  return {
    type: 'session_end',
    content: [
      `### Session End`,
      `- ${data.ticketsCompleted} tickets completed, ${data.ticketsFailed} failed${costLine}`,
      `- Duration: ${duration}`,
    ].join('\n'),
  };
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}
