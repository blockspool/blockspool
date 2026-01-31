/**
 * Learnings repository — stores lessons from ticket failures
 * to avoid repeating the same mistakes.
 */

import type { DatabaseAdapter } from '../db/index.js';
import { nanoid } from '../utils/id.js';

export interface Learning {
  id: string;
  projectId: string;
  ticketId: string | null;
  runId: string | null;
  content: string;
  source: string;
  promoted: boolean;
  createdAt: string;
}

/**
 * Insert a learning from a failed ticket run.
 */
export async function insertFromFailure(
  db: DatabaseAdapter,
  opts: {
    projectId: string;
    ticketId: string;
    runId: string;
    content: string;
    source?: string;
  }
): Promise<string> {
  const id = `lrn_${nanoid(12)}`;
  await db.query(
    `INSERT INTO learnings (id, project_id, ticket_id, run_id, content, source)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, opts.projectId, opts.ticketId, opts.runId, opts.content, opts.source ?? 'auto-failure']
  );
  return id;
}

/**
 * Get recent learnings for a project, newest first.
 */
export async function getRecent(
  db: DatabaseAdapter,
  projectId: string,
  limit = 20
): Promise<Learning[]> {
  const result = await db.query(
    `SELECT id, project_id, ticket_id, run_id, content, source, promoted, created_at
     FROM learnings
     WHERE project_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [projectId, limit]
  );
  return result.rows.map((r) => ({
    id: r.id as string,
    projectId: r.project_id as string,
    ticketId: r.ticket_id as string | null,
    runId: r.run_id as string | null,
    content: r.content as string,
    source: r.source as string,
    promoted: Boolean(r.promoted),
    createdAt: r.created_at as string,
  }));
}

/**
 * Format learnings as a prompt block for the scout.
 */
export function formatForScoutPrompt(learnings: Learning[]): string | undefined {
  if (learnings.length === 0) return undefined;

  const lines = learnings.map(l => `- ${l.content}`);
  return [
    '',
    '## Lessons from Previous Failures',
    'The following issues were learned from recent failed tickets. Avoid proposing similar work:',
    ...lines,
    '',
  ].join('\n');
}
