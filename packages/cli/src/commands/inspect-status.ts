import { Command } from 'commander';
import chalk from 'chalk';
import { projects, tickets, runs } from '@promptwheel/core/repos';
import { getDbPath } from '../lib/solo-config.js';
import {
  resolveRepoRootOrExit,
  withCommandAdapter,
} from '../lib/command-runtime.js';
import {
  formatDuration,
  formatRelativeTime,
} from '../lib/solo-utils.js';
import {
  buildStatusJsonOutput,
  getExecuteStatusDetails,
  loadSpinTextSummary,
  loadDrillTextSummary,
} from '../lib/inspect-status-service.js';

export function registerInspectStatusCommand(solo: Command): void {
  solo
    .command('status')
    .description('Show local state and active tickets')
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .action(async (options: { verbose?: boolean; json?: boolean }) => {
      const repoRoot = await resolveRepoRootOrExit({
        json: options.json,
        notRepoJsonShape: 'errorOnly',
      });

      const dbPath = getDbPath(repoRoot);
      await withCommandAdapter(repoRoot, async (adapter) => {
        if (options.json) {
          const output = await buildStatusJsonOutput(repoRoot, dbPath, adapter);
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        const projectList = await projects.list(adapter);

        console.log(chalk.blue('📊 PromptWheel Solo Status'));
        console.log();
        console.log(chalk.gray(`Database: ${dbPath}`));
        console.log();

        console.log(`Projects: ${projectList.length}`);

        if (projectList.length === 0) {
          console.log(chalk.yellow('\nNo projects found. Run: promptwheel solo scout .'));
          return;
        }

        for (const project of projectList) {
          console.log();
          console.log(chalk.bold(project.name));

          const summary = await runs.getSummary(adapter, project.id);

          if (summary.lastScout) {
            const scout = summary.lastScout;
            const statusColor = scout.status === 'success' ? chalk.green :
              scout.status === 'failure' ? chalk.red : chalk.yellow;
            const timeAgo = scout.completedAt ? formatRelativeTime(scout.completedAt) : 'running';

            console.log();
            console.log(`  ${chalk.cyan('Last Scout:')}`);
            console.log(`    ${statusColor(scout.status)} | ${timeAgo}`);
            console.log(`    ${scout.scannedFiles} files scanned, ${scout.proposalCount} proposals, ${scout.ticketCount} tickets`);
            if (scout.durationMs > 0) {
              console.log(`    Duration: ${formatDuration(scout.durationMs)}`);
            }
          }

          if (summary.lastQa) {
            const qa = summary.lastQa;
            const statusColor = qa.status === 'success' ? chalk.green :
              qa.status === 'failure' ? chalk.red : chalk.yellow;
            const timeAgo = qa.completedAt ? formatRelativeTime(qa.completedAt) : 'running';
            const passFailText = `${qa.stepsPassed} passed, ${qa.stepsFailed} failed`;

            console.log();
            console.log(`  ${chalk.cyan('Last QA:')}`);
            console.log(`    ${statusColor(qa.status)} | ${timeAgo}`);
            console.log(`    ${passFailText}`);
            if (qa.durationMs > 0) {
              console.log(`    Duration: ${formatDuration(qa.durationMs)}`);
            }
          }

          if (summary.lastExecute) {
            const exec = summary.lastExecute;
            const executeDetails = await getExecuteStatusDetails(repoRoot, adapter, exec);

            const isNoChangesNeeded = executeDetails.completionOutcome === 'no_changes_needed';
            const isSpindleFailure = exec.status === 'failure' && executeDetails.spindleInfo?.reason;
            const statusColor = exec.status === 'success' ? chalk.green :
              isSpindleFailure ? chalk.yellow :
                exec.status === 'failure' ? chalk.red : chalk.yellow;
            const timeAgo = exec.completedAt ? formatRelativeTime(exec.completedAt) : 'running';

            console.log();
            console.log(`  ${chalk.cyan('Last Execute:')}`);
            if (isSpindleFailure) {
              console.log(`    ${statusColor('failed')} (Spindle: ${executeDetails.spindleInfo!.reason}) | ${timeAgo}`);
              console.log(chalk.gray(`    See artifacts: ${executeDetails.spindleInfo!.artifactPath}`));
            } else if (isNoChangesNeeded) {
              console.log(`    ${statusColor('success')} (no changes needed) | ${timeAgo}`);
            } else {
              console.log(`    ${statusColor(exec.status)} | ${timeAgo}`);
            }
            if (exec.ticketId) {
              console.log(`    Ticket: ${exec.ticketId}`);
            }
            if (exec.branchName) {
              console.log(`    Branch: ${exec.branchName}`);
            }
            if (exec.prUrl) {
              console.log(`    PR: ${chalk.cyan(exec.prUrl)}`);
            }
            if (exec.durationMs > 0) {
              console.log(`    Duration: ${formatDuration(exec.durationMs)}`);
            }
          }

          const counts = await tickets.countByStatus(adapter, project.id);
          const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

          console.log();
          console.log(`  ${chalk.cyan('Tickets:')}`);
          if (total === 0) {
            console.log(chalk.gray('    No tickets'));
          } else {
            for (const [status, count] of Object.entries(counts)) {
              if (count === 0) continue;
              const color = status === 'done' ? chalk.green :
                status === 'blocked' || status === 'aborted' ? chalk.red :
                  status === 'in_progress' || status === 'leased' ? chalk.yellow :
                    chalk.gray;
              console.log(`    ${color(status)}: ${count}`);
            }
          }

          if (summary.activeRuns > 0) {
            console.log(`    ${chalk.cyan('active runs')}: ${summary.activeRuns}`);
          }
        }

        const spinSummary = await loadSpinTextSummary(repoRoot);
        if (spinSummary) {
          const qualityPct = Math.round(spinSummary.qualityRate * 100);
          const qualitySignals = spinSummary.qualitySignals;

          console.log();
          console.log(`  ${chalk.cyan('Spin:')}`);
          if (qualitySignals && qualitySignals.totalTickets > 0) {
            const qaStr = (qualitySignals.qaPassed + qualitySignals.qaFailed) > 0
              ? `${qualitySignals.qaPassed}/${qualitySignals.qaPassed + qualitySignals.qaFailed}`
              : 'untested';
            console.log(
              `    Quality rate: ${qualityPct}%    ` +
              `(first-pass: ${qualitySignals.firstPassSuccess}/${qualitySignals.totalTickets}, QA: ${qaStr})`,
            );
          } else {
            console.log(chalk.gray('    Quality rate: 100% (no data)'));
          }
          console.log(
            `    Confidence: ${spinSummary.currentConfidence}       ` +
            `(original: ${spinSummary.originalConfidence}` +
            `${spinSummary.confidenceDelta !== 0
              ? `, delta: ${spinSummary.confidenceDelta > 0 ? '+' : ''}${spinSummary.confidenceDelta}`
              : ''})`,
          );
          if (spinSummary.disabledCommands.length > 0) {
            console.log(`    Disabled commands:    ${spinSummary.disabledCommands.join(', ')}`);
          } else {
            console.log('    Disabled commands:    none');
          }
          console.log(`    Meta-learnings:       ${spinSummary.processInsightsCount} process insights`);

          if (spinSummary.qaCommands.length > 0) {
            console.log('    QA command stats:');
            for (const stats of spinSummary.qaCommands) {
              const rate = stats.totalRuns > 0 ? Math.round((stats.successes / stats.totalRuns) * 100) : null;
              const rateStr = rate !== null ? `${rate}% success` : 'no data';
              const avgStr = stats.totalRuns > 0
                ? (stats.avgDurationMs >= 1000
                  ? `avg ${(stats.avgDurationMs / 1000).toFixed(1)}s`
                  : `avg ${stats.avgDurationMs}ms`)
                : '';
              console.log(`      ${stats.name}:  ${rateStr}${avgStr ? `, ${avgStr}` : ''}  (${stats.totalRuns} runs)`);
            }
          }
        }

        const drillSummary = await loadDrillTextSummary(repoRoot);
        if (drillSummary) {
          const completionPct = Math.round(drillSummary.completionRate * 100);

          console.log();
          console.log(`  ${chalk.cyan('Drill:')}`);
          console.log(
            `    History: ${drillSummary.totalTrajectories} trajectories ` +
            `(${drillSummary.completedTrajectories} completed, ` +
            `${drillSummary.stalledTrajectories} stalled) — ${completionPct}% completion`,
          );
          console.log(`    Ambition: ${drillSummary.ambition}`);
          if (drillSummary.topCategories.length > 0) {
            console.log(`    Top categories: ${drillSummary.topCategories.join(', ')}`);
          }
          if (drillSummary.stalledCategories.length > 0) {
            console.log(`    Stalled categories: ${drillSummary.stalledCategories.join(', ')}`);
          }
          if (drillSummary.activeTrajectory) {
            if (
              drillSummary.activeTrajectory.completedSteps !== null &&
              drillSummary.activeTrajectory.totalSteps !== null
            ) {
              console.log(
                `    Active trajectory: ${drillSummary.activeTrajectory.name} ` +
                `(${drillSummary.activeTrajectory.completedSteps}/${drillSummary.activeTrajectory.totalSteps} steps)`,
              );
            } else {
              console.log(`    Active trajectory: ${drillSummary.activeTrajectory.name}`);
            }
          }
        }
      });
    });
}
