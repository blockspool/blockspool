/**
 * Solo mode git utilities
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

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
): Promise<{ success: boolean; conflicted: boolean; aiResolved?: boolean }> {
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

        // AI merge conflict resolution: attempt merge, let conflicts stay, resolve with Claude
        try {
          const aiResult = await aiResolveConflicts(milestoneWorktreePath, ticketBranch);
          if (aiResult) {
            return { success: true, conflicted: false, aiResolved: true };
          }
        } catch {
          // AI resolution failed, clean up
          try { await gitExec('git merge --abort', { cwd: milestoneWorktreePath }); } catch { /* ignore */ }
        }

        return { success: false, conflicted: true };
      }
    }
  });
}

/**
 * Attempt AI-powered merge conflict resolution.
 * Starts a merge (letting conflicts stay), reads conflict markers,
 * spawns Claude to resolve them, stages the result, and commits.
 */
async function aiResolveConflicts(
  worktreePath: string,
  ticketBranch: string
): Promise<boolean> {
  // Start the merge but don't abort on conflict
  try {
    await gitExec(`git merge --no-ff "${ticketBranch}" -m "Merge ${ticketBranch}"`, {
      cwd: worktreePath,
    });
    // If this succeeds, no conflict — should not reach here but handle it
    return true;
  } catch {
    // Expected: merge has conflicts. Conflict markers are in working tree.
  }

  // Find conflicted files
  const statusOutput = await gitExec('git diff --name-only --diff-filter=U', {
    cwd: worktreePath,
  });
  const conflictedFiles = statusOutput.trim().split('\n').filter(Boolean);

  if (conflictedFiles.length === 0) {
    await gitExec('git merge --abort', { cwd: worktreePath });
    return false;
  }

  // Read conflict markers from each file
  const fileContents: string[] = [];
  for (const file of conflictedFiles) {
    const filePath = path.join(worktreePath, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      fileContents.push(`=== ${file} ===\n${content}`);
    }
  }

  // Build resolution prompt
  const prompt = [
    'You are resolving git merge conflicts. For each file below, the content contains',
    'conflict markers (<<<<<<< HEAD, =======, >>>>>>> branch). Resolve each conflict by',
    'choosing the best combination of both sides. Output ONLY the resolved file contents,',
    'with the same === filename === delimiters. No explanations.',
    '',
    ...fileContents,
  ].join('\n');

  // Spawn Claude to resolve
  const resolved = await runClaudeForMerge(worktreePath, prompt);
  if (!resolved) {
    await gitExec('git merge --abort', { cwd: worktreePath });
    return false;
  }

  // Parse resolved output and write files
  const resolvedFiles = parseResolvedFiles(resolved);
  if (resolvedFiles.size === 0) {
    await gitExec('git merge --abort', { cwd: worktreePath });
    return false;
  }

  // Write resolved content and stage
  for (const [file, content] of resolvedFiles) {
    const filePath = path.join(worktreePath, file);
    fs.writeFileSync(filePath, content, 'utf-8');
    await gitExec(`git add "${file}"`, { cwd: worktreePath });
  }

  // Verify no remaining conflict markers
  for (const file of conflictedFiles) {
    const filePath = path.join(worktreePath, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes('<<<<<<<') || content.includes('>>>>>>>')) {
      await gitExec('git merge --abort', { cwd: worktreePath });
      return false;
    }
  }

  // Commit the merge
  await gitExec(`git commit --no-edit`, { cwd: worktreePath });
  return true;
}

/**
 * Run Claude CLI for merge conflict resolution (short timeout, sonnet model).
 */
function runClaudeForMerge(cwd: string, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['-p', '--model', 'sonnet', '--dangerously-skip-permissions'], {
      cwd,
      env: { ...process.env, CLAUDE_CODE_NON_INTERACTIVE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, 120000); // 2 minute timeout for merge resolution

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve(code === 0 && stdout.trim() ? stdout : null);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Parse Claude's resolved file output back into individual files.
 */
function parseResolvedFiles(output: string): Map<string, string> {
  const result = new Map<string, string>();
  const sections = output.split(/^=== (.+?) ===/m);

  // sections[0] is before first delimiter (empty), then pairs of [filename, content]
  for (let i = 1; i < sections.length; i += 2) {
    const filename = sections[i].trim();
    const content = sections[i + 1];
    if (filename && content !== undefined) {
      result.set(filename, content.replace(/^\n/, ''));  // trim leading newline after delimiter
    }
  }

  return result;
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
