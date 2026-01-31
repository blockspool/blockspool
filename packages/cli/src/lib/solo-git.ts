/**
 * Solo mode git utilities
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Mutex for serializing git operations on the main repo.
 * Git doesn't support concurrent index operations on the same repo,
 * so worktree setup (fetch, branch, worktree add) must be serialized.
 * Once worktrees are created, per-worktree git ops are safe in parallel.
 */
let gitMutexPromise: Promise<void> = Promise.resolve();
export function withGitMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = gitMutexPromise;
  let resolve: () => void;
  gitMutexPromise = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

/**
 * Async git command execution — does not block the event loop.
 * Used instead of execSync to allow parallel ticket execution.
 */
export async function gitExec(
  cmd: string,
  opts: { cwd: string; encoding?: 'utf-8'; maxBuffer?: number; stdio?: 'ignore' }
): Promise<string> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execPromise = promisify(exec);
  const result = await execPromise(cmd, {
    cwd: opts.cwd,
    encoding: opts.encoding || 'utf-8',
    maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
  });
  return result.stdout;
}

/**
 * Clean up worktree safely
 */
export async function cleanupWorktree(repoRoot: string, worktreePath: string) {
  try {
    if (fs.existsSync(worktreePath)) {
      await gitExec(`git worktree remove --force "${worktreePath}"`, { cwd: repoRoot });
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a milestone branch and persistent worktree for batch merging.
 * Returns the branch name and worktree path.
 */
export async function createMilestoneBranch(
  repoRoot: string,
  baseBranch: string
): Promise<{ milestoneBranch: string; milestoneWorktreePath: string }> {
  const ts = Date.now().toString(36);
  const milestoneBranch = `blockspool/milestone-${ts}`;
  const milestoneWorktreePath = path.join(repoRoot, '.blockspool', 'worktrees', '_milestone');

  await withGitMutex(async () => {
    // Ensure worktrees dir exists
    const worktreesDir = path.join(repoRoot, '.blockspool', 'worktrees');
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    // Clean up any existing milestone worktree
    if (fs.existsSync(milestoneWorktreePath)) {
      await gitExec(`git worktree remove --force "${milestoneWorktreePath}"`, { cwd: repoRoot });
    }

    // Fetch latest
    try {
      await gitExec(`git fetch origin ${baseBranch}`, { cwd: repoRoot });
    } catch {
      // Continue with what we have
    }

    // Create milestone branch from origin/baseBranch
    try {
      await gitExec(`git branch "${milestoneBranch}" "origin/${baseBranch}"`, { cwd: repoRoot });
    } catch {
      // Branch may already exist
    }

    await gitExec(`git worktree add "${milestoneWorktreePath}" "${milestoneBranch}"`, { cwd: repoRoot });
  });

  return { milestoneBranch, milestoneWorktreePath };
}

/**
 * Merge a ticket branch into the milestone branch under git mutex.
 * Returns success/conflict status.
 */
export async function mergeTicketToMilestone(
  repoRoot: string,
  ticketBranch: string,
  milestoneWorktreePath: string
): Promise<{ success: boolean; conflicted: boolean }> {
  return withGitMutex(async () => {
    try {
      await gitExec(`git merge --no-ff "${ticketBranch}" -m "Merge ${ticketBranch}"`, {
        cwd: milestoneWorktreePath,
      });
      return { success: true, conflicted: false };
    } catch {
      // Abort the failed merge
      try {
        await gitExec('git merge --abort', { cwd: milestoneWorktreePath });
      } catch {
        // Ignore abort errors
      }

      // Retry: rebase ticket branch onto milestone, then merge
      try {
        const milestoneBranchName = (await gitExec('git rev-parse --abbrev-ref HEAD', {
          cwd: milestoneWorktreePath,
        })).trim();
        // Rebase the ticket branch onto the current milestone tip
        await gitExec(`git rebase "${milestoneBranchName}" "${ticketBranch}"`, {
          cwd: repoRoot,
        });
        // Try merge again
        await gitExec(`git merge --no-ff "${ticketBranch}" -m "Merge ${ticketBranch}"`, {
          cwd: milestoneWorktreePath,
        });
        return { success: true, conflicted: false };
      } catch {
        // Abort any in-progress rebase or merge
        try { await gitExec('git rebase --abort', { cwd: repoRoot }); } catch { /* ignore */ }
        try { await gitExec('git merge --abort', { cwd: milestoneWorktreePath }); } catch { /* ignore */ }
        return { success: false, conflicted: true };
      }
    }
  });
}

/**
 * Push milestone branch and create a squash-merge draft PR to the base branch.
 * Returns the PR URL.
 */
export async function pushAndPrMilestone(
  repoRoot: string,
  milestoneBranch: string,
  milestoneWorktreePath: string,
  milestoneNumber: number,
  ticketCount: number,
  summaries: string[]
): Promise<string | undefined> {
  // Push safety: validate origin matches allowed remote
  const { assertPushSafe } = await import('./solo-remote.js');
  const { loadConfig } = await import('./solo-config.js');
  const config = loadConfig(repoRoot);
  await assertPushSafe(milestoneWorktreePath, config?.allowedRemote);

  // Push the milestone branch
  await gitExec(`git push -u origin "${milestoneBranch}"`, { cwd: milestoneWorktreePath });

  // Build PR body
  const bulletList = summaries.map(s => `- ${s}`).join('\n');
  const title = `Milestone #${milestoneNumber}: ${ticketCount} improvements`;
  const body = `## Milestone #${milestoneNumber}\n\n${ticketCount} tickets merged:\n\n${bulletList}\n\n---\n_Created by BlockSpool (milestone mode)_`;

  try {
    const prOutput = (await gitExec(
      `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --head "${milestoneBranch}" --draft`,
      { cwd: milestoneWorktreePath }
    )).trim();

    const urlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+/);
    return urlMatch ? urlMatch[0] : undefined;
  } catch {
    // PR might already exist for this branch — try to find it
    try {
      const existing = (await gitExec(
        `gh pr view "${milestoneBranch}" --json url --jq .url`,
        { cwd: milestoneWorktreePath }
      )).trim();
      if (existing.startsWith('https://')) return existing;
    } catch {
      // ignore
    }
    return undefined;
  }
}

/**
 * Clean up the milestone worktree (but not the branch, which may have a PR).
 */
export async function cleanupMilestone(repoRoot: string): Promise<void> {
  const milestoneWorktreePath = path.join(repoRoot, '.blockspool', 'worktrees', '_milestone');
  await cleanupWorktree(repoRoot, milestoneWorktreePath);
}
