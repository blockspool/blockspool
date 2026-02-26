import { Command } from 'commander';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';

export function registerInspectHistoryCommand(solo: Command): void {
  solo
    .command('history')
    .description('View auto run history')
    .option('-n, --limit <n>', 'Number of entries to show', '10')
    .option('--json', 'Output as JSON')
    .action(async (options: { limit?: string; json?: boolean }) => {
      const { readRunHistory, formatHistoryEntry } = await import('../lib/run-history.js');
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      const entries = readRunHistory(repoRoot || undefined, parseInt(options.limit || '10', 10));

      if (entries.length === 0) {
        console.log(chalk.gray('No history yet. Run `promptwheel solo auto` to get started.'));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      console.log(chalk.bold(`Run History (${entries.length} entries):\n`));
      for (const entry of entries) {
        console.log(formatHistoryEntry(entry));
        console.log();
      }
    });
}
