/**
 * Analytics command - view metrics from instrumented systems
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import { analyzeMetrics, readMetrics, type MetricsSummary } from '../lib/metrics.js';
import { readRunHistory, type RunHistoryEntry } from '../lib/run-history.js';
import { getLearningEffectiveness } from '../lib/learnings.js';
import {
  classifyCompactAnalyticsInsights,
  collectCompactAnalyticsInsights,
  type LearningStats,
} from '../lib/analytics/collectors.js';
import { printFramedList } from '../lib/analytics/render.js';

export function registerAnalyticsCommands(solo: Command): void {
  solo
    .command('analytics')
    .description('View system metrics and identify what\'s valuable')
    .option('--raw', 'Show raw metrics data')
    .option('--system <name>', 'Filter by system (learnings, dedup, spindle, sectors, wave)')
    .option('--verbose', 'Show detailed per-system breakdown')
    .action(async (options: { raw?: boolean; system?: string; verbose?: boolean }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      const events = readMetrics(repoRoot);

      if (events.length === 0) {
        console.log(chalk.yellow('No metrics data yet.'));
        console.log(chalk.gray('Run promptwheel to generate metrics.'));
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
      const history = readRunHistory(repoRoot, 50);
      const learningStats = getLearningEffectiveness(repoRoot);

      if (options.verbose) {
        displayVerboseAnalytics(summary, learningStats);
      } else {
        displayCompactAnalytics(summary, history, learningStats, repoRoot);
      }
    });
}

/**
 * Compact analytics display - what's working, what needs attention, recommendations
 */
function displayCompactAnalytics(
  summary: MetricsSummary,
  history: RunHistoryEntry[],
  learningStats: LearningStats,
  repoRoot: string,
): void {
  const duration = summary.timeRange.end - summary.timeRange.start;
  const hours = Math.round(duration / 3600000 * 10) / 10;

  console.log(chalk.cyan('\n📊 PromptWheel Value Report\n'));
  console.log(chalk.gray(`Data: ${new Date(summary.timeRange.start).toLocaleDateString()} to ${new Date(summary.timeRange.end).toLocaleDateString()} (${hours}h)`));
  console.log();

  const insights = collectCompactAnalyticsInsights({
    summary,
    history,
    learningStats,
    repoRoot,
  });
  const { working, attention, recommendations } = classifyCompactAnalyticsInsights(insights);

  // Display sections
  if (working.length > 0) {
    printFramedList({
      title: 'WORKING WELL',
      marker: '✓',
      items: working,
      colorize: chalk.green,
    });
    console.log();
  }

  if (attention.length > 0) {
    printFramedList({
      title: 'NEEDS ATTENTION',
      marker: '⚠',
      items: attention,
      colorize: chalk.yellow,
    });
    console.log();
  }

  if (recommendations.length > 0) {
    printFramedList({
      title: 'RECOMMENDATIONS',
      marker: '•',
      items: recommendations,
      colorize: chalk.cyan,
    });
    console.log();
  }

  if (working.length === 0 && attention.length === 0) {
    console.log(chalk.gray('Not enough data yet. Run more sessions to generate insights.'));
    console.log();
  }

  console.log(chalk.gray('Use --verbose for detailed per-system breakdown.'));
  console.log();
}

/**
 * Verbose analytics display - full per-system breakdown
 */
function displayVerboseAnalytics(summary: MetricsSummary, learningStats: LearningStats): void {
  const duration = summary.timeRange.end - summary.timeRange.start;
  const hours = Math.round(duration / 3600000 * 10) / 10;

  console.log(chalk.cyan('\n📊 System Value Analysis (Verbose)\n'));
  console.log(chalk.gray(`Data from: ${new Date(summary.timeRange.start).toLocaleDateString()} to ${new Date(summary.timeRange.end).toLocaleDateString()}`));
  console.log(chalk.gray(`Total events: ${summary.totalEvents} over ${hours}h\n`));

  // Learnings analysis with effectiveness
  const learnings = summary.bySystem['learnings'];
  console.log(chalk.white('📚 Learnings System'));
  if (learnings) {
    console.log(chalk.gray(`   Loaded: ${learnings.events['loaded'] || 0} times`));
    console.log(chalk.gray(`   Selected: ${learnings.events['selected'] || 0} times`));
  }
  console.log(chalk.gray(`   Total stored: ${learningStats.total}`));
  console.log(chalk.gray(`   Applied: ${learningStats.applied} times`));
  if (learningStats.applied > 0) {
    const effPct = Math.round(learningStats.successRate * 100);
    const effColor = effPct >= 70 ? chalk.green : effPct >= 50 ? chalk.yellow : chalk.red;
    console.log(effColor(`   Effectiveness: ${effPct}%`));
  }
  if (learningStats.topPerformers.length > 0) {
    console.log(chalk.gray('   Top performers:'));
    for (const p of learningStats.topPerformers.slice(0, 3)) {
      const effPct = Math.round(p.effectiveness * 100);
      const truncText = p.text.length > 40 ? p.text.slice(0, 40) + '...' : p.text;
      console.log(chalk.gray(`     ${effPct}%: ${truncText}`));
    }
  }
  console.log();

  // Dedup analysis
  const dedup = summary.bySystem['dedup'];
  if (dedup) {
    console.log(chalk.white('🔄 Dedup Memory'));
    console.log(chalk.gray(`   Loaded: ${dedup.events['loaded'] || 0} times`));
    console.log(chalk.gray(`   Duplicates blocked: ${dedup.events['duplicate_found'] || 0}`));
    const value = (dedup.events['duplicate_found'] || 0) > 0 ? '✓ Saving work' : '○ No duplicates found';
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
    const partitions = wave.events['partitioned'] || 0;
    const value = partitions > 0 ? '✓ Parallelization active' : '○ Not used (parallel=1?)';
    console.log(chalk.gray(`   Value: ${value}\n`));
  }

  // Session tracking
  const session = summary.bySystem['session'];
  if (session) {
    console.log(chalk.white('📍 Sessions'));
    console.log(chalk.gray(`   Started: ${session.events['started'] || 0}`));
    console.log();
  }
}
