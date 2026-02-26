import { Command } from 'commander';
import chalk from 'chalk';
import { approveProposals } from '@promptwheel/core/services';
import { getLatestArtifact } from '../lib/artifacts.js';
import { parseSelection } from '../lib/selection.js';
import {
  getPromptwheelDir,
  createScoutDeps,
} from '../lib/solo-config.js';
import {
  resolveRepoRootOrExit,
  withCommandAdapter,
} from '../lib/command-runtime.js';
import type { ProposalsArtifact } from '../lib/solo-utils.js';

export function registerInspectApproveCommand(solo: Command): void {
  solo
    .command('approve <selection>')
    .description('Approve proposals and create tickets')
    .addHelpText('after', `
Selection formats:
  1         Single proposal (1-indexed)
  1,3,5     Multiple specific proposals
  1-3       Range of proposals
  1-3,5,7   Mixed selection
  all       All proposals

Examples:
  promptwheel solo approve 1       # Approve first proposal
  promptwheel solo approve 1-3     # Approve proposals 1, 2, 3
  promptwheel solo approve all     # Approve all proposals
`)
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .action(async (selection: string, options: { verbose?: boolean; json?: boolean }) => {
      const isJsonMode = options.json;
      const repoRoot = await resolveRepoRootOrExit({ json: isJsonMode });

      const baseDir = getPromptwheelDir(repoRoot);
      const artifact = getLatestArtifact<ProposalsArtifact>(baseDir, 'proposals');

      if (!artifact) {
        if (isJsonMode) {
          console.log(JSON.stringify({
            success: false,
            error: 'No proposals found. Run: promptwheel solo scout .',
          }));
        } else {
          console.error(chalk.red('✗ No proposals found'));
          console.log(chalk.gray('  Run: promptwheel solo scout .'));
        }
        process.exit(1);
      }

      const { proposals } = artifact.data;

      if (proposals.length === 0) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'No proposals in artifact' }));
        } else {
          console.error(chalk.red('✗ No proposals in artifact'));
        }
        process.exit(1);
      }

      let selectedIndices: number[];
      try {
        selectedIndices = parseSelection(selection, proposals.length);
      } catch (error) {
        if (isJsonMode) {
          console.log(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        } else {
          console.error(chalk.red(`✗ Invalid selection: ${error instanceof Error ? error.message : error}`));
          console.log(chalk.gray(`  Valid range: 1-${proposals.length}`));
        }
        process.exit(1);
      }

      if (selectedIndices.length === 0) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'No proposals selected' }));
        } else {
          console.error(chalk.red('✗ No proposals selected'));
          console.log(chalk.gray(`  Valid range: 1-${proposals.length}`));
        }
        process.exit(1);
      }

      const selectedProposals = selectedIndices.map((index) => proposals[index]);

      if (!isJsonMode) {
        console.log(chalk.blue('📋 PromptWheel Solo Approve'));
        console.log();
        console.log(`Selected ${selectedProposals.length} proposal(s):`);
        for (const index of selectedIndices) {
          const proposal = proposals[index];
          console.log(`  ${chalk.bold(index + 1)}. ${proposal.title}`);
        }
        console.log();
      }

      await withCommandAdapter(repoRoot, async (adapter) => {
        const deps = createScoutDeps(adapter, options);
        const createdTickets = await approveProposals(
          deps,
          artifact.data.projectId,
          selectedProposals,
        );

        if (isJsonMode) {
          console.log(JSON.stringify({
            success: true,
            tickets: createdTickets.map((ticket) => ({
              id: ticket.id,
              title: ticket.title,
              status: ticket.status,
            })),
          }));
        } else {
          console.log(chalk.green(`✓ Created ${createdTickets.length} ticket(s)`));
          for (const ticket of createdTickets) {
            console.log(`  ${chalk.gray(ticket.id)} ${ticket.title}`);
          }
          console.log();
          console.log(chalk.blue('Next steps:'));
          console.log(`  promptwheel solo run ${createdTickets[0]?.id}  # Run a ticket`);
          console.log('  promptwheel solo status                # View all tickets');
        }
      });
    });
}
