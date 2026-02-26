/**
 * Solo execution commands: run, retry, pr
 */

import { Command } from 'commander';
import * as path from 'node:path';
import chalk from 'chalk';
import type { DatabaseAdapter } from '@promptwheel/core/db';
import { tickets, runs } from '@promptwheel/core/repos';
import {
  loadConfig,
} from '../lib/solo-config.js';
import {
  ensureInitializedOrExit,
  exitCommand,
  exitCommandError,
  resolveRepoRootOrExit,
  withCommandAdapter,
} from '../lib/command-runtime.js';
import {
  formatDuration,
  findConflictingTickets,
  regenerateAllowedPaths,
  runPreflightChecks,
} from '../lib/solo-utils.js';
import { cleanupWorktree } from '../lib/solo-git.js';
import { soloRunTicket } from '../lib/solo-ticket.js';
import { EXIT_CODES, type RunTicketResult } from '../lib/solo-ticket-types.js';

type TicketRecord = NonNullable<Awaited<ReturnType<typeof tickets.getById>>>;

type RunMetadata = Record<string, unknown> & {
  branchName?: string;
  prUrl?: string;
};

interface LatestSuccessfulRunRow {
  id: string;
  metadata: string | null;
}

interface RunSigintController {
  setCurrentRunId(runId: string): void;
  wasInterrupted(): boolean;
  exitIfInterrupted(): void;
  dispose(): void;
}

function emitHeader(isJsonMode: boolean, title: string): void {
  if (!isJsonMode) {
    console.log(chalk.blue(title));
    console.log();
  }
}

function emitResponse(options: {
  json: boolean;
  jsonPayload: Record<string, unknown>;
  human: () => void;
  jsonIndent?: number;
}): void {
  if (options.json) {
    console.log(JSON.stringify(options.jsonPayload, null, options.jsonIndent));
    return;
  }

  options.human();
}

function renderTicketOverview(ticket: TicketRecord): void {
  console.log(`Ticket: ${chalk.bold(ticket.title)}`);
  console.log(chalk.gray(`  ID: ${ticket.id}`));
  console.log(chalk.gray(`  Status: ${ticket.status}`));
  console.log();
}

async function getTicketOrExit(
  adapter: DatabaseAdapter,
  ticketId: string,
  json: boolean,
): Promise<TicketRecord> {
  const ticket = await tickets.getById(adapter, ticketId);

  if (!ticket) {
    exitCommandError({
      json,
      message: `Ticket not found: ${ticketId}`,
    });
  }

  return ticket;
}

async function runPreflightOrExit(options: {
  repoRoot: string;
  json: boolean;
  needsPr: boolean;
  printWarnings?: boolean;
}): Promise<void> {
  const preflight = await runPreflightChecks(options.repoRoot, { needsPr: options.needsPr });
  if (!preflight.ok) {
    exitCommandError({
      json: options.json,
      message: preflight.error,
    });
  }

  if (options.printWarnings) {
    for (const warning of preflight.warnings) {
      console.log(chalk.yellow(`⚠ ${warning}`));
    }
  }
}

function parseRunMetadata(metadata: string | null): RunMetadata {
  if (!metadata) {
    return {};
  }

  return JSON.parse(metadata) as RunMetadata;
}

function mergeRunMetadata(metadata: string | null, patch: Record<string, unknown>): RunMetadata {
  return {
    ...parseRunMetadata(metadata),
    ...patch,
  };
}

function createRunSigintController(options: {
  repoRoot: string;
  ticketId: string;
  adapter: DatabaseAdapter;
  json: boolean;
}): RunSigintController {
  let currentRunId: string | null = null;
  let interrupted = false;
  let interruptedExitCode: number | null = null;

  const sigintHandler = async () => {
    if (interrupted) {
      return;
    }
    interrupted = true;

    try {
      if (!options.json) {
        console.log(chalk.yellow('\n\nInterrupted. Cleaning up...'));
      }

      const worktreePath = path.join(options.repoRoot, '.promptwheel', 'worktrees', options.ticketId);
      await cleanupWorktree(options.repoRoot, worktreePath);
      await tickets.updateStatus(options.adapter, options.ticketId, 'ready');
      if (currentRunId) {
        await runs.markFailure(options.adapter, currentRunId, 'Interrupted by user (SIGINT)');
      }
    } catch {
      // Ignore cleanup errors
    }

    if (!options.json) {
      console.log(chalk.gray('Ticket reset to ready. You can retry with: promptwheel solo run ' + options.ticketId));
    }

    interruptedExitCode = EXIT_CODES.SIGINT;
  };

  process.on('SIGINT', sigintHandler);

  return {
    setCurrentRunId(runId: string): void {
      currentRunId = runId;
    },
    wasInterrupted(): boolean {
      return interrupted;
    },
    exitIfInterrupted(): void {
      if (interrupted) {
        exitCommand(interruptedExitCode ?? EXIT_CODES.SIGINT, 'Interrupted by user (SIGINT)');
      }
    },
    dispose(): void {
      process.removeListener('SIGINT', sigintHandler);
    },
  };
}

function buildRunJsonOutput(runId: string, ticketId: string, result: RunTicketResult): Record<string, unknown> {
  const output: Record<string, unknown> = {
    success: result.success,
    runId,
    ticketId,
    branchName: result.branchName,
    prUrl: result.prUrl,
    durationMs: result.durationMs,
    error: result.error,
    failureReason: result.failureReason,
    completionOutcome: result.completionOutcome,
    artifacts: result.artifacts,
  };

  if (result.failureReason === 'spindle_abort' && result.spindle) {
    output.spindle = {
      trigger: result.spindle.trigger,
      estimatedTokens: result.spindle.estimatedTokens,
      threshold: result.spindle.thresholds.tokenBudgetAbort,
      iteration: result.spindle.iteration,
      confidence: result.spindle.confidence,
    };
  }

  return output;
}

function exitRunFailure(options: {
  json: boolean;
  runId: string;
  ticketId: string;
  result: RunTicketResult;
}): never {
  const { json, runId, ticketId, result } = options;

  if (json) {
    const jsonOutput = buildRunJsonOutput(runId, ticketId, result);
    const spindleExtra = jsonOutput.spindle !== undefined ? { spindle: jsonOutput.spindle } : {};

    exitCommandError({
      json: true,
      exitCode: result.failureReason === 'spindle_abort'
        ? EXIT_CODES.SPINDLE_ABORT
        : EXIT_CODES.FAILURE,
      message: result.error ?? (
        result.failureReason === 'spindle_abort'
          ? 'Execution stopped by Spindle'
          : 'Ticket execution failed'
      ),
      jsonExtra: {
        runId,
        ticketId,
        branchName: result.branchName,
        prUrl: result.prUrl,
        durationMs: result.durationMs,
        failureReason: result.failureReason,
        completionOutcome: result.completionOutcome,
        artifacts: result.artifacts,
        ...spindleExtra,
      },
    });
  }

  if (result.failureReason === 'spindle_abort' && result.spindle) {
    const humanDetails: string[] = [
      `  Stopped execution to prevent ${result.spindle.trigger}`,
      '',
      '  Why:',
    ];

    if (result.spindle.trigger === 'token_budget') {
      humanDetails.push(`  Token estimate ~${result.spindle.estimatedTokens.toLocaleString()} > abort limit ${result.spindle.thresholds.tokenBudgetAbort.toLocaleString()}`);
    } else if (result.spindle.trigger === 'stalling') {
      humanDetails.push(`  ${result.spindle.metrics.iterationsWithoutChange} iterations without meaningful changes`);
    } else if (result.spindle.trigger === 'oscillation') {
      humanDetails.push(`  Detected flip-flopping: ${result.spindle.metrics.oscillationPattern ?? 'add→remove→add pattern'}`);
    } else if (result.spindle.trigger === 'repetition') {
      humanDetails.push(`  Similar outputs detected (${(result.spindle.confidence * 100).toFixed(0)}% similarity)`);
    }

    humanDetails.push('');
    humanDetails.push('  What to do:');
    for (const rec of result.spindle.recommendations.slice(0, 3)) {
      humanDetails.push(chalk.gray(`  • ${rec}`));
    }
    humanDetails.push('');
    humanDetails.push(chalk.gray(`  Artifacts: ${result.spindle.artifactPath}`));
    humanDetails.push(chalk.gray(`  Duration: ${formatDuration(result.durationMs)}`));

    exitCommandError({
      exitCode: EXIT_CODES.SPINDLE_ABORT,
      message: 'Execution stopped by Spindle (loop protection)',
      humanDetails,
    });
  }

  const humanDetails: string[] = [];
  if (result.branchName) {
    humanDetails.push(chalk.gray(`  Branch preserved: ${result.branchName}`));
    humanDetails.push(chalk.gray('  Inspect with: git checkout ' + result.branchName));
  }
  humanDetails.push(chalk.gray('  Retry with: promptwheel solo run ' + ticketId));
  humanDetails.push(chalk.gray(`  Duration: ${formatDuration(result.durationMs)}`));

  exitCommandError({
    exitCode: EXIT_CODES.FAILURE,
    message: `Ticket failed: ${result.error ?? 'Unknown error'}`,
    humanDetails,
  });
}

function registerRunCommand(solo: Command): void {
  solo
    .command('run <ticketId>')
    .description('Execute a ticket using Claude Code CLI')
    .addHelpText('after', `
This command:
1. Creates an isolated git worktree
2. Runs Claude Code CLI with the ticket prompt
3. Validates changes with QA commands
4. Creates a PR (or commits to a feature branch)

Rerun behavior:
- ready/blocked tickets: runs normally
- in_progress tickets: warns about possible crashed run, continues
- done/in_review tickets: skips (use --force to override)

Examples:
  promptwheel solo run tkt_abc123         # Run ticket
  promptwheel solo run tkt_abc123 --pr    # Create PR after success
  promptwheel solo run tkt_abc123 --force # Force rerun of completed ticket
`)
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .option('--pr', 'Create PR after successful run')
    .option('--no-qa', 'Skip QA validation')
    .option('--timeout <ms>', 'Claude execution timeout', '600000')
    .option('-f, --force', 'Force rerun of done/in_review tickets')
    .action(async (ticketId: string, options: {
      verbose?: boolean;
      json?: boolean;
      pr?: boolean;
      qa?: boolean;
      timeout?: string;
      force?: boolean;
    }) => {
      const isJsonMode = options.json ?? false;
      const skipQa = options.qa === false;
      const createPr = options.pr ?? false;
      const timeoutMs = parseInt(options.timeout ?? '600000', 10);
      const forceRerun = options.force ?? false;

      emitHeader(isJsonMode, '🚀 PromptWheel Solo Run');

      const repoRoot = await resolveRepoRootOrExit({ json: isJsonMode });
      await runPreflightOrExit({
        repoRoot,
        json: isJsonMode,
        needsPr: createPr,
        printWarnings: !isJsonMode,
      });

      await ensureInitializedOrExit({
        repoRoot,
        json: isJsonMode,
        autoInit: true,
      });

      const config = loadConfig(repoRoot);

      await withCommandAdapter(repoRoot, async (adapter) => {
        const sigintController = createRunSigintController({
          repoRoot,
          ticketId,
          adapter,
          json: isJsonMode,
        });

        try {
          const ticket = await getTicketOrExit(adapter, ticketId, isJsonMode);

          if (!isJsonMode) {
            renderTicketOverview(ticket);
          }

          if (ticket.status === 'done' || ticket.status === 'in_review') {
            if (!forceRerun) {
              emitResponse({
                json: isJsonMode,
                jsonPayload: {
                  success: false,
                  error: `Ticket already ${ticket.status}. Use --force to rerun.`,
                },
                human: () => {
                  console.log(chalk.yellow(`Ticket already ${ticket.status}. Use --force to rerun.`));
                },
              });
              return;
            }
            if (!isJsonMode) {
              console.log(chalk.yellow(`⚠ Force rerunning ${ticket.status} ticket`));
            }
          }

          if (ticket.status === 'in_progress') {
            if (!isJsonMode) {
              console.log(chalk.yellow('⚠ Ticket was in_progress (previous run may have crashed)'));
              console.log(chalk.gray('  Cleaning up and retrying...'));
              console.log();
            }
            const worktreePath = path.join(repoRoot, '.promptwheel', 'worktrees', ticketId);
            await cleanupWorktree(repoRoot, worktreePath);
          }

          const conflicts = await findConflictingTickets(adapter, ticket);
          if (conflicts.length > 0 && !forceRerun) {
            const conflictData = conflicts.map(c => ({
              ticketId: c.ticket.id,
              title: c.ticket.title,
              overlappingPaths: c.overlappingPaths,
            }));
            const humanDetails: string[] = [];
            for (const conflict of conflicts) {
              humanDetails.push(chalk.gray(`  ${conflict.ticket.id}: ${conflict.ticket.title}`));
              humanDetails.push(chalk.gray(`    Status: ${conflict.ticket.status}`));
              humanDetails.push(chalk.gray('    Overlapping paths:'));
              for (const overlap of conflict.overlappingPaths.slice(0, 5)) {
                humanDetails.push(chalk.gray(`      - ${overlap}`));
              }
              if (conflict.overlappingPaths.length > 5) {
                humanDetails.push(chalk.gray(`      ... and ${conflict.overlappingPaths.length - 5} more`));
              }
            }
            humanDetails.push('');
            humanDetails.push(chalk.gray('Use --force to run anyway.'));
            exitCommandError({
              json: isJsonMode,
              message: 'Conflicting tickets detected with overlapping paths',
              jsonExtra: { conflicts: conflictData },
              humanDetails,
            });
          } else if (conflicts.length > 0 && !isJsonMode) {
            console.log(chalk.yellow('⚠ Running despite conflicting tickets (--force):'));
            for (const conflict of conflicts) {
              console.log(chalk.gray(`  • ${conflict.ticket.id}: ${conflict.ticket.title}`));
            }
            console.log();
          }

          await tickets.updateStatus(adapter, ticketId, 'in_progress');

          const run = await runs.create(adapter, {
            projectId: ticket.projectId,
            type: 'worker',
            ticketId: ticket.id,
            metadata: {
              skipQa,
              createPr,
              timeoutMs,
            },
          });
          sigintController.setCurrentRunId(run.id);

          if (!isJsonMode) {
            console.log(chalk.gray(`Run: ${run.id}`));
            console.log();
          }

          const result = await soloRunTicket({
            ticket,
            repoRoot,
            config,
            adapter,
            runId: run.id,
            skipQa,
            createPr,
            timeoutMs,
            verbose: options.verbose ?? false,
            onProgress: (msg) => {
              if (!isJsonMode && !sigintController.wasInterrupted()) {
                console.log(chalk.gray(`  ${msg}`));
              }
            },
          });

          sigintController.exitIfInterrupted();

          if (result.success) {
            await runs.markSuccess(adapter, run.id, {
              branchName: result.branchName,
              prUrl: result.prUrl,
              durationMs: result.durationMs,
              completionOutcome: result.completionOutcome,
            });
            await tickets.updateStatus(adapter, ticketId, result.prUrl ? 'in_review' : 'done');
          } else {
            await runs.markFailure(adapter, run.id, result.error ?? 'Unknown error', {
              durationMs: result.durationMs,
              branchName: result.branchName,
            });
            await tickets.updateStatus(adapter, ticketId, 'blocked');
          }

          if (!result.success) {
            exitRunFailure({
              json: isJsonMode,
              runId: run.id,
              ticketId: ticket.id,
              result,
            });
          }

          emitResponse({
            json: isJsonMode,
            jsonPayload: buildRunJsonOutput(run.id, ticket.id, result),
            jsonIndent: 2,
            human: () => {
              console.log();
              if (result.completionOutcome === 'no_changes_needed') {
                console.log(chalk.green('✓ Ticket completed - no changes needed'));
                console.log(chalk.gray('  Claude reviewed the ticket and determined no code changes were required'));
                console.log(chalk.gray(`  Duration: ${formatDuration(result.durationMs)}`));
                return;
              }

              console.log(chalk.green('✓ Ticket completed successfully'));
              if (result.branchName) {
                console.log(chalk.gray(`  Branch: ${result.branchName}`));
              }
              if (result.prUrl) {
                console.log(chalk.cyan(`  PR: ${result.prUrl}`));
              }
              console.log(chalk.gray(`  Duration: ${formatDuration(result.durationMs)}`));
            },
          });
        } finally {
          sigintController.dispose();
        }
      });
    });
}

function registerRetryCommand(solo: Command): void {
  solo
    .command('retry <ticketId>')
    .description('Reset a blocked ticket to ready status and regenerate allowed_paths')
    .addHelpText('after', `
This command resets a blocked ticket so it can be run again.

What it does:
1. Resets the ticket status to 'ready'
2. Regenerates allowed_paths using current scope expansion logic
3. Optionally allows updating the ticket description

Use this when:
- A ticket failed and is now blocked
- You want to retry with regenerated scope
- You want to update the ticket description before retrying

Examples:
  promptwheel solo retry tkt_abc123                    # Reset blocked ticket
  promptwheel solo retry tkt_abc123 -d "New desc"     # Reset with new description
  promptwheel solo retry tkt_abc123 --force           # Reset even if not blocked
`)
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .option('-d, --description <text>', 'Update the ticket description')
    .option('-f, --force', 'Force reset even if ticket is not blocked')
    .action(async (ticketId: string, options: {
      verbose?: boolean;
      json?: boolean;
      description?: string;
      force?: boolean;
    }) => {
      const isJsonMode = options.json ?? false;
      const forceReset = options.force ?? false;
      const newDescription = options.description;

      emitHeader(isJsonMode, '🔄 PromptWheel Solo Retry');

      const repoRoot = await resolveRepoRootOrExit({ json: isJsonMode });
      await ensureInitializedOrExit({
        repoRoot,
        json: isJsonMode,
        notInitializedMessage: 'Not initialized. Run: promptwheel solo init',
        notInitializedHumanMessage: 'Not initialized',
        notInitializedHumanPrefix: '✗',
        notInitializedHumanDetails: [chalk.gray('  Run: promptwheel solo init')],
        notInitializedHumanDetailsToStdout: true,
      });

      await withCommandAdapter(repoRoot, async (adapter) => {
        const ticket = await getTicketOrExit(adapter, ticketId, isJsonMode);

        if (options.verbose) {
          console.log(chalk.gray(`  Ticket: ${ticket.title}`));
          console.log(chalk.gray(`  Current status: ${ticket.status}`));
          console.log(chalk.gray(`  Category: ${ticket.category ?? 'none'}`));
        }

        if (ticket.status !== 'blocked' && !forceReset) {
          exitCommandError({
            json: isJsonMode,
            message: `Ticket is ${ticket.status}, not blocked. Use --force to reset anyway.`,
          });
        }

        const newAllowedPaths = regenerateAllowedPaths(ticket);

        const updates: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        updates.push(`status = $${paramIndex++}`);
        params.push('ready');

        updates.push(`allowed_paths = $${paramIndex++}`);
        params.push(JSON.stringify(newAllowedPaths));

        if (newDescription !== undefined) {
          updates.push(`description = $${paramIndex++}`);
          params.push(newDescription);
        }

        updates.push(`updated_at = datetime('now')`);

        params.push(ticketId);

        await adapter.query(
          `UPDATE tickets SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
          params,
        );

        const updatedTicket = await getTicketOrExit(adapter, ticketId, isJsonMode);

        emitResponse({
          json: isJsonMode,
          jsonPayload: {
            success: true,
            ticket: {
              id: updatedTicket.id,
              title: updatedTicket.title,
              status: updatedTicket.status,
              allowedPaths: updatedTicket.allowedPaths,
              description: updatedTicket.description,
            },
            changes: {
              statusFrom: ticket.status,
              statusTo: 'ready',
              allowedPathsCount: newAllowedPaths.length,
              descriptionUpdated: newDescription !== undefined,
            },
          },
          human: () => {
            console.log(chalk.green('✓ Ticket reset successfully'));
            console.log();
            console.log(chalk.gray(`  ID: ${updatedTicket.id}`));
            console.log(chalk.gray(`  Title: ${updatedTicket.title}`));
            console.log(chalk.gray(`  Status: ${ticket.status} → ready`));
            console.log(chalk.gray(`  Allowed paths: ${newAllowedPaths.length} paths`));
            if (options.verbose && newAllowedPaths.length > 0) {
              for (const p of newAllowedPaths.slice(0, 5)) {
                console.log(chalk.gray(`    - ${p}`));
              }
              if (newAllowedPaths.length > 5) {
                console.log(chalk.gray(`    ... and ${newAllowedPaths.length - 5} more`));
              }
            }
            if (newDescription !== undefined) {
              console.log(chalk.gray('  Description: updated'));
            }
            console.log();
            console.log(chalk.blue('Next step:'));
            console.log(`  promptwheel solo run ${ticketId}`);
          },
        });
      });
    });
}

function registerPrCommand(solo: Command): void {
  solo
    .command('pr <ticketId>')
    .description('Create a PR for a completed ticket branch')
    .addHelpText('after', `
This command creates a PR for a ticket that was completed without --pr.

Use this when:
- A ticket ran successfully but --pr was not specified
- The branch was pushed but PR creation was skipped

Examples:
  promptwheel solo pr tkt_abc123         # Create PR for ticket's branch
`)
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .action(async (ticketId: string, options: {
      verbose?: boolean;
      json?: boolean;
    }) => {
      const isJsonMode = options.json ?? false;

      emitHeader(isJsonMode, '🔗 PromptWheel Solo PR');

      const repoRoot = await resolveRepoRootOrExit({ json: isJsonMode });
      await runPreflightOrExit({
        repoRoot,
        json: isJsonMode,
        needsPr: true,
      });

      await ensureInitializedOrExit({
        repoRoot,
        json: isJsonMode,
        notInitializedMessage: 'Solo mode not initialized. Run: promptwheel solo init',
      });

      await withCommandAdapter(repoRoot, async (adapter) => {
        const ticket = await getTicketOrExit(adapter, ticketId, isJsonMode);

        if (!isJsonMode) {
          renderTicketOverview(ticket);
        }

        const result = await adapter.query<LatestSuccessfulRunRow>(
          `SELECT id, metadata FROM runs
           WHERE ticket_id = $1 AND status = 'success' AND type = 'worker'
           ORDER BY completed_at DESC
           LIMIT 1`,
          [ticketId],
        );

        const runRow = result.rows[0];
        if (!runRow) {
          exitCommandError({
            json: isJsonMode,
            message: 'No successful run found for this ticket',
            humanDetails: [chalk.gray('  The ticket must have completed successfully before creating a PR.')],
          });
        }

        const metadata = parseRunMetadata(runRow.metadata);
        const branchName = metadata.branchName as string | undefined;

        if (!branchName) {
          exitCommandError({
            json: isJsonMode,
            message: 'No branch name found in run metadata',
          });
        }

        if (metadata.prUrl) {
          emitResponse({
            json: isJsonMode,
            jsonPayload: { success: true, prUrl: metadata.prUrl, alreadyExists: true },
            human: () => {
              console.log(chalk.yellow(`PR already exists: ${metadata.prUrl}`));
            },
          });
          return;
        }

        if (!isJsonMode) {
          console.log(chalk.gray(`Branch: ${branchName}`));
          console.log(chalk.gray('Creating PR...'));
        }

        const { execFileSync } = await import('child_process');
        try {
          execFileSync('git', ['ls-remote', '--heads', 'origin', branchName], { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' });
        } catch {
          exitCommandError({
            json: isJsonMode,
            message: `Branch not found on remote: ${branchName}`,
            humanDetails: [chalk.gray('  The branch must be pushed to the remote before creating a PR.')],
          });
        }

        try {
          const prBody = `## Summary\n\n${ticket.description ?? ticket.title}\n\n---\n_Created by PromptWheel_`;

          const prOutput = execFileSync(
            'gh', ['pr', 'create', '--title', ticket.title, '--body', prBody, '--head', branchName],
            { cwd: repoRoot, encoding: 'utf-8' },
          ).trim();

          const urlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+/);
          const prUrl = urlMatch ? urlMatch[0] : undefined;

          if (prUrl) {
            const updatedMetadata = mergeRunMetadata(runRow.metadata, { prUrl });
            await adapter.query(
              'UPDATE runs SET metadata = $1 WHERE id = $2',
              [JSON.stringify(updatedMetadata), runRow.id],
            );

            await tickets.updateStatus(adapter, ticketId, 'in_review');

            emitResponse({
              json: isJsonMode,
              jsonPayload: { success: true, prUrl, branchName },
              human: () => {
                console.log();
                console.log(chalk.green('✓ PR created successfully'));
                console.log(chalk.cyan(`  ${prUrl}`));
              },
            });
            return;
          }

          emitResponse({
            json: isJsonMode,
            jsonPayload: { success: false, error: 'PR created but could not parse URL' },
            human: () => {
              console.log(chalk.yellow('⚠ PR created but could not parse URL'));
              console.log(chalk.gray(`  Output: ${prOutput}`));
            },
          });
        } catch (prError) {
          const errorMessage = prError instanceof Error ? prError.message : String(prError);
          exitCommandError({
            json: isJsonMode,
            message: `Failed to create PR: ${errorMessage}`,
          });
        }
      });
    });
}

export function registerExecCommands(solo: Command): void {
  registerRunCommand(solo);
  registerRetryCommand(solo);
  registerPrCommand(solo);
}
