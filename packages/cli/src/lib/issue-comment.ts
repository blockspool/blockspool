/**
 * GitHub issue comment-back — posts a structured comment when a PR
 * is created from an issue-driven ticket.
 *
 * Completes the viral loop: issue → auto-fix → PR → comment on issue.
 */

import { execSync } from 'node:child_process';

export interface CommentOnIssueOptions {
  repoRoot: string;
  issueNumber: number;
  prUrl: string;
  ticketTitle: string;
}

export function commentOnIssue(options: CommentOnIssueOptions): void {
  const { repoRoot, issueNumber, prUrl, ticketTitle } = options;

  const body = [
    `**PromptWheel** created a fix for this issue:`,
    '',
    `**PR:** ${prUrl}`,
    `**Ticket:** ${ticketTitle}`,
    '',
    '_This fix was generated automatically. Please review the PR before merging._',
  ].join('\n');

  try {
    execSync(
      `gh issue comment ${issueNumber} --body ${JSON.stringify(body)}`,
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000,
      },
    );
  } catch (err) {
    // Non-fatal — log and continue
    console.warn(
      `[promptwheel] Failed to comment on issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
