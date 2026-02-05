/**
 * Analytics command - view metrics from instrumented systems
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import { analyzeMetrics, readMetrics } from '../lib/metrics.js';

export function registerAnalyticsCommands(solo: Command): void {
  solo
    .command('analytics')
    .description('View system metrics and identify what\'s valuable')
    .option('--raw', 'Show raw metrics data')
    .option('--system <name>', 'Filter by system (learnings, dedup, spindle, sectors, wave)')
    .action(async (options: { raw?: boolean; system?: string }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      const events = readMetrics(repoRoot);

      if (events.length === 0) {
        console.log(chalk.yellow('No metrics data yet.'));
        console.log(chalk.gray('Run blockspool to generate metrics.'));
        return;
      }

      if (options.raw) {
        const filtered = options.system
          ? events.filter(e => e.system === options.system)
          : events;
        for (const event of filtered.slice(-100)) {
          console.log(JSON.stringify(event));
        }
        return;
      }

      const summary = analyzeMetrics(repoRoot);

      console.log(chalk.cyan('\n📊 System Value Analysis\n'));

      const duration = summary.timeRange.end - summary.timeRange.start;
      const hours = Math.round(duration / 3600000 * 10) / 10;
      console.log(chalk.gray(`Data from: ${new Date(summary.timeRange.start).toLocaleDateString()} to ${new Date(summary.timeRange.end).toLocaleDateString()}`));
      console.log(chalk.gray(`Total events: ${summary.totalEvents} over ${hours}h\n`));

      // Learnings analysis
      const learnings = summary.bySystem['learnings'];
      if (learnings) {
        console.log(chalk.white('📚 Learnings System'));
        console.log(chalk.gray(`   Loaded: ${learnings.events['loaded'] || 0} times`));
        console.log(chalk.gray(`   Selected: ${learnings.events['selected'] || 0} times`));
        const value = learnings.events['selected'] > 0 ? '✓ Active' : '⚠ Not used';
        console.log(chalk.gray(`   Value: ${value}\n`));
      }

      // Dedup analysis
      const dedup = summary.bySystem['dedup'];
      if (dedup) {
        console.log(chalk.white('🔄 Dedup Memory'));
        console.log(chalk.gray(`   Loaded: ${dedup.events['loaded'] || 0} times`));
        console.log(chalk.gray(`   Duplicates blocked: ${dedup.events['duplicate_found'] || 0}`));
        const value = (dedup.events['duplicate_found'] || 0) > 0 ? '✓ Saving work' : '⚠ No duplicates found';
        console.log(chalk.gray(`   Value: ${value}\n`));
      }

      // Spindle analysis
      const spindle = summary.bySystem['spindle'];
      if (spindle) {
        console.log(chalk.white('🔴 Spindle (Loop Detection)'));
        console.log(chalk.gray(`   Checks passed: ${spindle.events['check_passed'] || 0}`));
        console.log(chalk.gray(`   Triggered: ${spindle.events['triggered'] || 0}`));
        const triggered = spindle.events['triggered'] || 0;
        const value = triggered > 0 ? '✓ Preventing loops' : '○ No loops detected';
        console.log(chalk.gray(`   Value: ${value}\n`));
      }

      // Sectors analysis
      const sectors = summary.bySystem['sectors'];
      if (sectors) {
        console.log(chalk.white('🗺️  Sectors (Scope Rotation)'));
        console.log(chalk.gray(`   Picks: ${sectors.events['picked'] || 0}`));
        const value = (sectors.events['picked'] || 0) > 1 ? '✓ Rotating coverage' : '⚠ Minimal rotation';
        console.log(chalk.gray(`   Value: ${value}\n`));
      }

      // Wave scheduling analysis
      const wave = summary.bySystem['wave'];
      if (wave) {
        console.log(chalk.white('🌊 Wave Scheduling'));
        console.log(chalk.gray(`   Partitions: ${wave.events['partitioned'] || 0}`));
        console.log(chalk.gray(`   Value: Check if parallelization is used\n`));
      }

      // Session tracking
      const session = summary.bySystem['session'];
      if (session) {
        console.log(chalk.white('📍 Sessions'));
        console.log(chalk.gray(`   Started: ${session.events['started'] || 0}`));
      }

      console.log(chalk.cyan('\nRecommendations:'));
      console.log(chalk.gray('Systems with "⚠" may not be providing value.'));
      console.log(chalk.gray('Run more sessions to gather data.\n'));
    });
}
