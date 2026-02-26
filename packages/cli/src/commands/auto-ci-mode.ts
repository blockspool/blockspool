/**
 * CI fix mode handler for solo auto.
 */

import * as path from 'node:path';
import chalk from 'chalk';
import { projects, tickets } from '@promptwheel/core/repos';
import {
  loadConfig,
} from '../lib/solo-config.js';
import { soloRunTicket } from '../lib/solo-ticket.js';
import { spawnSyncSafe, getCurrentBranch, getCIStatus, getFailureLogs, parseFailure, extractFailureScope, generateCIFixDescription } from '../lib/solo-ci.js';
import {
  ensureInitializedOrExit,
  exitCommandError,
  resolveRepoRootOrExit,
  withCommandAdapter,
} from '../lib/command-runtime.js';

export async function handleCiMode(options: {
  dryRun?: boolean;
  verbose?: boolean;
  branch?: string;
}): Promise<void> {
  console.log(chalk.blue('🛞 PromptWheel Auto - CI Fix'));
  console.log();

  const repoRoot = await resolveRepoRootOrExit({
    notRepoHumanDetails: ['  Run this command from within a git repository'],
  });
  await ensureInitializedOrExit({
    repoRoot,
    notInitializedMessage: 'PromptWheel not initialized',
    notInitializedHumanDetails: [chalk.gray('  Run: promptwheel solo init')],
  });

  const ghResult = spawnSyncSafe('gh', ['--version']);
  if (!ghResult.ok) {
    exitCommandError({
      message: 'GitHub CLI (gh) not found',
      humanDetails: [chalk.gray('  Install: https://cli.github.com/')],
    });
  }

  const targetBranch = options.branch || await getCurrentBranch(repoRoot);
  console.log(chalk.gray(`Branch: ${targetBranch}`));

  console.log(chalk.gray('Checking CI status...'));
  const ciStatus = await getCIStatus(repoRoot, targetBranch);

  if (ciStatus.status === 'success') {
    console.log(chalk.green('✓ CI is passing. Nothing to fix.'));
    return;
  }

  if (ciStatus.status === 'pending') {
    console.log(chalk.yellow('⏳ CI is still running. Wait for it to complete.'));
    return;
  }

  if (ciStatus.status === 'unknown') {
    exitCommandError({
      message: 'Could not determine CI status',
      humanDetails: [chalk.gray('  Make sure gh is authenticated and the repo has GitHub Actions')],
    });
  }

  console.log(chalk.red(`✗ CI failed: ${ciStatus.conclusion || 'failure'}`));
  console.log();

  if (ciStatus.failedJobs.length === 0) {
    exitCommandError({
      message: 'Could not identify failed jobs',
      humanDetails: [chalk.gray('  Check GitHub Actions manually')],
    });
  }

  console.log(chalk.bold('Failed jobs:'));
  for (const job of ciStatus.failedJobs) {
    console.log(chalk.red(`  • ${job.name}`));
  }
  console.log();

  console.log(chalk.gray('Fetching failure logs...'));
  const logs = await getFailureLogs(ciStatus.runId, ciStatus.failedJobs[0].id);

  if (!logs) {
    exitCommandError({
      message: 'Could not fetch failure logs',
    });
  }

  const failure = parseFailure(logs);

  if (!failure) {
    const humanDetails: string[] = [chalk.gray('  The failure format may not be supported yet')];
    if (options.verbose) {
      humanDetails.push('');
      humanDetails.push(chalk.gray('--- Last 50 lines of logs ---'));
      humanDetails.push(logs.split('\n').slice(-50).join('\n'));
    }
    exitCommandError({
      message: 'Could not parse failure from logs',
      humanDetails,
    });
  }

  console.log(chalk.bold('Detected failure:'));
  console.log(`  Type: ${failure.type}`);
  if (failure.framework) console.log(`  Framework: ${failure.framework}`);
  console.log(`  Message: ${failure.message}`);
  if (failure.file) console.log(`  File: ${failure.file}${failure.line ? `:${failure.line}` : ''}`);
  console.log();

  const scope = extractFailureScope(failure);
  console.log(chalk.bold('Affected files:'));
  for (const file of scope) {
    console.log(chalk.gray(`  • ${file}`));
  }
  console.log();

  if (options.dryRun) {
    console.log(chalk.yellow('Dry run - no changes made'));
    console.log();
    console.log(chalk.bold('Would create ticket:'));
    console.log(`  Title: Fix ${failure.type} failure${failure.file ? ` in ${failure.file}` : ''}`);
    console.log(`  Scope: ${scope.join(', ')}`);
    console.log();
    console.log('Run without --dry-run to fix the issue.');
    return;
  }

  await withCommandAdapter(repoRoot, async (adapter) => {
    const project = await projects.ensureForRepo(adapter, {
      name: path.basename(repoRoot),
      rootPath: repoRoot,
    });

    const title = `Fix ${failure.type} failure${failure.file ? ` in ${failure.file}` : ''}`;
    const description = generateCIFixDescription(failure, scope, ciStatus);

    const ticket = await tickets.create(adapter, {
      projectId: project.id,
      title,
      description,
      priority: 1,
      allowedPaths: scope.length > 0 ? scope : undefined,
      forbiddenPaths: ['node_modules', '.git', 'dist', 'build'],
    });
    const ciTicketId = ticket.id;

    console.log(chalk.green(`✓ Created ticket: ${ciTicketId}`));
    console.log(chalk.gray(`  Title: ${title}`));
    console.log();

    console.log(chalk.bold('Running ticket...'));
    const config = loadConfig(repoRoot);
    const runId = `run_${Date.now().toString(36)}`;

    const result = await soloRunTicket({
      ticket,
      repoRoot,
      config,
      adapter,
      runId,
      skipQa: false,
      createPr: true,
      draftPr: true,
      timeoutMs: 600000,
      verbose: options.verbose ?? false,
      onProgress: (msg) => {
        if (options.verbose) {
          console.log(chalk.gray(`  ${msg}`));
        }
      },
    });

    console.log();
    if (result.success) {
      console.log(chalk.green('✓ CI failure fixed!'));
      if (result.branchName) {
        console.log(chalk.gray(`  Branch: ${result.branchName}`));
      }
      if (result.prUrl) {
        console.log(chalk.cyan(`  PR: ${result.prUrl}`));
      }
      console.log();
      console.log('Next steps:');
      if (!result.prUrl) {
        console.log('  • Review the changes on the branch');
        console.log('  • Create a PR: promptwheel solo run ' + ciTicketId + ' --pr');
      } else {
        console.log('  • Review and merge the PR');
      }
      return;
    }

    const humanDetails: string[] = [];
    if (result.error) {
      humanDetails.push(chalk.gray(`  Error: ${result.error}`));
    }
    if (result.failureReason === 'spindle_abort') {
      humanDetails.push(chalk.yellow('  Agent stopped by Spindle (loop protection)'));
      humanDetails.push(chalk.gray('  The issue may be too complex for automated fixing'));
    }
    humanDetails.push('');
    humanDetails.push("Here's what I tried:");
    humanDetails.push(chalk.gray(`  Ticket: ${ciTicketId}`));
    humanDetails.push(chalk.gray(`  View: promptwheel solo artifacts --run ${runId}`));

    exitCommandError({
      message: 'Could not fix CI failure',
      humanDetails,
    });
  });
}
