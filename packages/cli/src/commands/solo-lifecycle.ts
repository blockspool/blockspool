/**
 * Solo lifecycle commands: init, doctor, reset
 */

import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import {
  getPromptwheelDir,
  getDbPath,
  isInitialized,
  initSolo,
} from '../lib/solo-config.js';
import {
  ensureInitializedOrExit,
  exitCommand,
  resolveRepoRootOrExit,
  withCommandAdapter,
  withOptionalCommandAdapter,
} from '../lib/command-runtime.js';
import {
  runDoctorChecks,
  formatDoctorReport,
  formatDoctorReportJson,
} from '../lib/doctor.js';

export function registerLifecycleCommands(solo: Command): void {
  /**
   * solo init - Initialize local state
   */
  solo
    .command('init')
    .description('Initialize PromptWheel local state for this repository')
    .option('-f, --force', 'Reinitialize even if already initialized')
    .option('-y, --yes', 'Skip confirmation (CI mode)')
    .action(async (options: { force?: boolean; yes?: boolean }) => {
      const repoRoot = await resolveRepoRootOrExit({
        notRepoHumanDetails: ['  Run this command from within a git repository'],
      });

      if (isInitialized(repoRoot) && !options.force) {
        console.log(chalk.yellow('Already initialized.'));
        console.log(chalk.gray(`  Config: ${getPromptwheelDir(repoRoot)}/config.json`));
        console.log(chalk.gray(`  Database: ${getDbPath(repoRoot)}`));
        console.log();
        console.log('Run with --force to reinitialize.');
        return;
      }

      // Detect project metadata before init for a rich summary
      const { detectProjectMetadata } = await import('../lib/project-metadata/index.js');
      const metadata = detectProjectMetadata(repoRoot);

      // Show project detection summary
      const projectParts: string[] = [];
      if (metadata.languages.length > 0) projectParts.push(metadata.languages.join(', '));
      if (metadata.framework) projectParts.push(metadata.framework);
      if (metadata.monorepo_tool) projectParts.push(`monorepo (${metadata.monorepo_tool})`);

      console.log();
      console.log(chalk.bold('Detected:'), projectParts.length > 0 ? projectParts.join(' + ') : chalk.gray('unknown project type'));

      const { config, detectedQa } = await initSolo(repoRoot);

      // Initialize database
      await withCommandAdapter(repoRoot, async () => undefined);

      console.log(chalk.green('✓ Initialized PromptWheel'));
      console.log();

      // Show QA commands in a compact format
      if (detectedQa.length > 0) {
        console.log(chalk.bold('QA commands:'));
        for (const cmd of detectedQa) {
          console.log(chalk.green(`  ✓ ${cmd.name}:`), chalk.gray(cmd.cmd));
        }
      } else {
        console.log(chalk.yellow('⚠ No QA commands detected'));
        console.log(chalk.gray('  Add qa.commands in .promptwheel/config.json'));
      }

      // Show setup command if detected
      if (config.setup) {
        console.log(chalk.bold('Setup:'), chalk.gray(config.setup));
      }

      // Suggest a starting formula based on project type
      const formulaSuggestions: string[] = ['default'];
      if (metadata.type_checker) formulaSuggestions.push('type-safety');
      if (metadata.test_runner) formulaSuggestions.push('test-coverage');
      if (metadata.linter) formulaSuggestions.push('cleanup');
      console.log(chalk.bold('Formulas:'), chalk.gray(formulaSuggestions.join(', ')));

      console.log();
      console.log(chalk.gray(`Config: .promptwheel/config.json`));

      console.log();
      console.log(chalk.bold('Next steps:'));
      console.log('  promptwheel                        Run in spin mode (default)');
      console.log('  promptwheel --plan                 Scout, review roadmap, execute');
      console.log('  promptwheel --formula deep         Architectural review');
      console.log('  promptwheel --formula security-audit  Security scan');
    });

  /**
   * solo report - View session reports
   */
  solo
    .command('report')
    .description('View session reports')
    .option('--list', 'List all reports')
    .option('--last', 'Show most recent report (default)')
    .action(async (options: { list?: boolean; last?: boolean }) => {
      const repoRoot = await resolveRepoRootOrExit();

      const reportsDir = path.join(getPromptwheelDir(repoRoot), 'reports');
      if (!fs.existsSync(reportsDir)) {
        console.log(chalk.gray('No reports yet. Run promptwheel to generate one.'));
        return;
      }

      const files = fs.readdirSync(reportsDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse();

      if (files.length === 0) {
        console.log(chalk.gray('No reports yet. Run promptwheel to generate one.'));
        return;
      }

      if (options.list) {
        for (const f of files) {
          console.log(f);
        }
      } else {
        const latest = files[0];
        console.log(fs.readFileSync(path.join(reportsDir, latest), 'utf-8'));
      }
    });

  /**
   * solo doctor - Check prerequisites and environment
   */
  solo
    .command('doctor')
    .description('Check prerequisites and environment health')
    .option('--json', 'Output as JSON')
    .option('-v, --verbose', 'Show all details')
    .action(async (options: { json?: boolean; verbose?: boolean }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      const report = await runDoctorChecks({
        repoRoot: repoRoot ?? undefined,
        verbose: options.verbose,
      });

      if (options.json) {
        console.log(formatDoctorReportJson(report));
      } else {
        console.log(formatDoctorReport(report));
      }

      if (!report.canRun) {
        exitCommand(1, 'Doctor checks failed');
      }
    });

  /**
   * solo reset - Clear all local state
   */
  solo
    .command('reset')
    .description('Clear all local state (destructive)')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (options: { force?: boolean }) => {
      const repoRoot = await resolveRepoRootOrExit();

      const dir = getPromptwheelDir(repoRoot);
      const dbPathVal = getDbPath(repoRoot);

      if (!fs.existsSync(dir)) {
        console.log(chalk.gray('No local state to clear'));
        return;
      }

      if (!options.force) {
        console.log(chalk.yellow('⚠ This will delete all local PromptWheel data:'));
        console.log(chalk.gray(`  ${dir}`));
        console.log();
        console.log('Run with --force to confirm.');
        exitCommand(1, 'Reset confirmation required');
      }

      if (fs.existsSync(dbPathVal)) {
        fs.unlinkSync(dbPathVal);
      }
      if (fs.existsSync(`${dbPathVal}-wal`)) {
        fs.unlinkSync(`${dbPathVal}-wal`);
      }
      if (fs.existsSync(`${dbPathVal}-shm`)) {
        fs.unlinkSync(`${dbPathVal}-shm`);
      }

      const configPath = path.join(dir, 'config.json');
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }

      try {
        fs.rmdirSync(dir);
      } catch {
        // Directory not empty, leave it
      }

      console.log(chalk.green('✓ Local state cleared'));
    });

  /**
   * solo prune - Clean up stale state
   */
  solo
    .command('prune').alias('clean')
    .description('Remove stale runs, history, artifacts, and archives')
    .option('--dry-run', 'Show what would be deleted without deleting')
    .action(async (options: { dryRun?: boolean }) => {
      const repoRoot = await resolveRepoRootOrExit();
      await ensureInitializedOrExit({
        repoRoot,
        notInitializedMessage: 'PromptWheel not initialized',
        notInitializedHumanDetails: [chalk.gray('  Run: promptwheel init')],
      });

      const { loadConfig } = await import('../lib/solo-config.js');
      const {
        pruneAllAsync,
        getRetentionConfig,
        formatPruneReport,
      } = await import('../lib/retention.js');

      const config = loadConfig(repoRoot);
      const retentionConfig = getRetentionConfig(config);

      const dryRun = options.dryRun ?? false;

      console.log(chalk.blue(dryRun ? 'Prune (dry run)' : 'Pruning stale state...'));
      console.log();

      await withOptionalCommandAdapter(repoRoot, async (adapter) => {
        const report = await pruneAllAsync(
          repoRoot,
          retentionConfig,
          adapter,
          dryRun,
        );

        console.log(formatPruneReport(report, dryRun));
        console.log();

        if (!dryRun && report.totalPruned > 0) {
          console.log(chalk.green(`✓ Pruned ${report.totalPruned} item(s)`));
        } else if (!dryRun) {
          console.log(chalk.green('✓ Nothing to prune'));
        }
      });
    });
}
