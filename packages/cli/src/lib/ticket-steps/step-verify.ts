/**
 * Step 4: Verify — run fast checks (type checker, linter) before commit.
 *
 * Catches type errors and lint failures early, giving the agent a chance
 * to fix them inline rather than waiting for the full QA step post-commit.
 */

import { execFile } from 'node:child_process';
import { normalizeQaConfig } from '../solo-utils.js';
import { buildTicketPrompt } from '../solo-prompt-builder.js';
import { LINTER_COMMANDS, TYPE_CHECKER_COMMANDS } from '../tool-command-map.js';
import { gitExec, gitExecFile } from '../solo-git.js';
import { parseChangedFiles } from '../scope.js';
import type { TicketContext, StepResult } from './types.js';

/** Run a shell command in the worktree, returning stdout+stderr and exit code. */
function runCommand(cmd: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    const [bin, ...args] = cmd.split(/\s+/);
    const child = execFile(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
      shell: true,
    }, (err, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).trim();
      if (err) {
        resolve({ ok: false, output });
      } else {
        resolve({ ok: true, output });
      }
    });
    // Defensive: if child itself errors (e.g. command not found)
    child.on('error', () => resolve({ ok: false, output: `Failed to execute: ${cmd}` }));
  });
}

/** Names of QA commands that are fast verifiers (linters + type checkers). */
const FAST_VERIFIER_NAMES = new Set([
  ...Object.keys(LINTER_COMMANDS),
  ...Object.keys(TYPE_CHECKER_COMMANDS),
  // Common QA command names that map to fast verifiers
  'lint', 'typecheck', 'type-check', 'types', 'check',
  'eslint', 'biome', 'tsc', 'mypy', 'pyright', 'ruff',
  'clippy', 'golangci-lint', 'rubocop', 'credo',
]);

/** Check if a QA command is a fast verifier based on name or command content. */
function isFastVerifier(name: string, cmd: string): boolean {
  const nameLower = name.toLowerCase();
  if (FAST_VERIFIER_NAMES.has(nameLower)) return true;

  // Check command content for known fast tools
  const cmdLower = cmd.toLowerCase();
  for (const tool of Object.keys(LINTER_COMMANDS)) {
    if (cmdLower.includes(tool)) return true;
  }
  for (const tool of Object.keys(TYPE_CHECKER_COMMANDS)) {
    if (cmdLower.includes(tool)) return true;
  }
  return false;
}

export async function run(ctx: TicketContext): Promise<StepResult> {
  const { ticket, config, worktreePath, opts, onProgress, execBackend, baselineFiles } = ctx;

  // Skip if no QA config or commands
  if (!config?.qa?.commands?.length) {
    await ctx.markStep('verify', 'skipped', { errorMessage: 'No QA configured' });
    return { continue: true };
  }

  const qaConfig = normalizeQaConfig(config);

  // Extract only fast verification commands (linters + type checkers)
  const verifyCommands = qaConfig.commands.filter(c => isFastVerifier(c.name, c.cmd));

  if (verifyCommands.length === 0) {
    await ctx.markStep('verify', 'skipped', { errorMessage: 'No fast verifiers in QA config' });
    return { continue: true };
  }

  // Skip commands that were already failing before the agent ran
  const effectiveCommands = ctx.qaBaseline
    ? verifyCommands.filter(c => ctx.qaBaseline!.get(c.name) !== false)
    : verifyCommands;

  if (effectiveCommands.length === 0) {
    await ctx.markStep('verify', 'skipped', { errorMessage: 'All verifiers were pre-existing failures' });
    return { continue: true };
  }

  await ctx.markStep('verify', 'started');
  onProgress(`Verify: running ${effectiveCommands.map(c => c.name).join(', ')}...`);

  // Run each verifier
  const failures: Array<{ name: string; output: string }> = [];
  for (const cmd of effectiveCommands) {
    const timeoutMs = cmd.timeoutMs ?? 60_000; // 60s default for fast verifiers
    const cwd = cmd.cwd && cmd.cwd !== '.' ? `${worktreePath}/${cmd.cwd}` : worktreePath;
    const result = await runCommand(cmd.cmd, cwd, timeoutMs);
    if (!result.ok) {
      failures.push({ name: cmd.name, output: result.output });
    }
  }

  if (failures.length === 0) {
    await ctx.markStep('verify', 'success');
    return { continue: true };
  }

  // Verification failed — try to fix inline
  onProgress(`Verify: ${failures.length} check(s) failed, re-invoking agent to fix...`);

  const errorSummary = failures.map(f => {
    const truncated = f.output.length > 1500
      ? '...' + f.output.slice(-1497)
      : f.output;
    return `## ${f.name} failed:\n${truncated}`;
  }).join('\n\n');

  const fixPrompt = buildTicketPrompt(
    ticket,
    opts.guidelinesContext,
    opts.learningsContext,
    opts.metadataContext,
  ) + '\n\n' + [
    'Your previous changes introduced errors. Fix them now. Do NOT revert the original changes — only fix the errors.',
    '',
    errorSummary,
  ].join('\n');

  try {
    const fixResult = await execBackend.run({
      worktreePath,
      prompt: fixPrompt,
      timeoutMs: opts.timeoutMs,
      verbose: opts.verbose,
      onProgress,
      onRawOutput: opts.onRawOutput,
    });

    if (!fixResult.success) {
      // Agent fix failed — continue anyway, let QA catch it
      onProgress('Verify: fix attempt failed, continuing to QA...');
      await ctx.markStep('verify', 'failed', {
        errorMessage: `Fix attempt failed: ${failures.map(f => f.name).join(', ')}`,
      });
      return { continue: true };
    }

    // Re-validate scope after fix (agent may have touched new files)
    const fixStatus = (await gitExec('git status --porcelain', { cwd: worktreePath })).trim();
    if (fixStatus) {
      const allFiles = parseChangedFiles(fixStatus);
      ctx.changedFiles = baselineFiles.size > 0
        ? allFiles.filter(f => !baselineFiles.has(f))
        : allFiles;
      ctx.statusOutput = fixStatus;
    }

    // Re-run verifiers to confirm fix
    let stillFailing = false;
    for (const cmd of effectiveCommands) {
      const timeoutMs = cmd.timeoutMs ?? 60_000;
      const cwd = cmd.cwd && cmd.cwd !== '.' ? `${worktreePath}/${cmd.cwd}` : worktreePath;
      const result = await runCommand(cmd.cmd, cwd, timeoutMs);
      if (!result.ok) {
        stillFailing = true;
        break;
      }
    }

    if (stillFailing) {
      // Still failing after fix — continue, let QA handle it
      onProgress('Verify: errors persist after fix attempt, continuing to QA...');
      await ctx.markStep('verify', 'failed', {
        errorMessage: `Still failing after fix: ${failures.map(f => f.name).join(', ')}`,
      });
      return { continue: true };
    }

    onProgress('Verify: errors fixed successfully');
    await ctx.markStep('verify', 'success', {
      metadata: { fixedInline: true, failedChecks: failures.map(f => f.name) },
    });
    return { continue: true };
  } catch {
    // Fix attempt threw — non-fatal, continue to QA
    onProgress('Verify: fix attempt errored, continuing to QA...');
    await ctx.markStep('verify', 'failed', {
      errorMessage: `Fix attempt errored: ${failures.map(f => f.name).join(', ')}`,
    });
    return { continue: true };
  }
}
