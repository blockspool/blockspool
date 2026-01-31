/**
 * Solo lifecycle commands: init, doctor, reset
 */

import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import {
  getBlockspoolDir,
  getDbPath,
  isInitialized,
  initSolo,
  getAdapter,
} from '../lib/solo-config.js';
import {
  runDoctorChecks,
  formatDoctorReport,
  formatDoctorReportJson,
} from '../lib/doctor.js';
import {
  isRepoAuthorized,
  authorizeRepo,
  deauthorizeRepo,
  listAuthorizedRepos,
  repoNameFromRemote,
} from '../lib/repo-registry.js';

export function registerLifecycleCommands(solo: Command): void {
  /**
   * solo init - Initialize local state
   */
  solo
    .command('init')
    .description('Initialize BlockSpool local state for this repository')
    .option('-f, --force', 'Reinitialize even if already initialized')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--repo <url>', 'Set the authorized remote URL (implies --yes)')
    .action(async (options: { force?: boolean; yes?: boolean; repo?: string }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        console.error('  Run this command from within a git repository');
        process.exit(1);
      }

      if (isInitialized(repoRoot) && !options.force) {
        console.log(chalk.yellow('Already initialized.'));
        console.log(chalk.gray(`  Config: ${getBlockspoolDir(repoRoot)}/config.json`));
        console.log(chalk.gray(`  Database: ${getDbPath(repoRoot)}`));
        console.log();
        console.log('Run with --force to reinitialize.');
        return;
      }

      // Detect the repo remote (--repo overrides auto-detection)
      let remoteUrl: string | undefined = options.repo;
      if (!remoteUrl) {
        try {
          const { execSync } = await import('child_process');
          remoteUrl = execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf-8' }).trim();
        } catch {
          // No remote — will proceed without whitelisting
        }
      }

      // --repo implies --yes (scripting mode)
      const skipPrompt = options.yes || !!options.repo;

      // Confirmation prompt: show what we're about to authorize
      if (!skipPrompt) {
        const repoName = remoteUrl ? repoNameFromRemote(remoteUrl) : path.basename(repoRoot);
        console.log(chalk.bold('Authorize repository for BlockSpool'));
        console.log();
        console.log(`  Repository:  ${chalk.cyan(repoName)}`);
        if (remoteUrl) {
          console.log(`  Remote:      ${chalk.gray(remoteUrl)}`);
        }
        console.log(`  Local path:  ${chalk.gray(repoRoot)}`);
        console.log();
        console.log(chalk.yellow('BlockSpool will scout this repo, execute changes in isolated'));
        console.log(chalk.yellow('worktrees, and create draft PRs. All changes go through QA.'));
        console.log();

        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(chalk.bold(`Authorize ${repoName}? [Y/n] `), resolve);
        });
        rl.close();

        if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
          console.log(chalk.gray('Cancelled.'));
          process.exit(0);
        }
      }

      const { config, detectedQa } = await initSolo(repoRoot, { remoteUrl });

      // Register in global allowed-repos list
      if (remoteUrl) {
        authorizeRepo(remoteUrl, repoRoot);
      }

      // Initialize database
      const adapter = await getAdapter(repoRoot);
      await adapter.close();

      console.log(chalk.green('✓ Initialized BlockSpool solo mode'));
      console.log(chalk.gray(`  Config: ${getBlockspoolDir(repoRoot)}/config.json`));
      console.log(chalk.gray(`  Database: ${config.dbPath}`));
      if (remoteUrl) {
        console.log(chalk.gray(`  Authorized: ${repoNameFromRemote(remoteUrl)}`));
        console.log(chalk.gray(`  Registry: ~/.blockspool/allowed-repos.json`));
      }

      // Show detected QA commands
      if (detectedQa.length > 0) {
        console.log();
        console.log(chalk.green('✓ Detected QA commands from package.json:'));
        for (const cmd of detectedQa) {
          console.log(chalk.gray(`  • ${cmd.name}: ${cmd.cmd}`));
        }
        console.log(chalk.gray('  (Edit .blockspool/config.json to customize)'));
      } else {
        console.log();
        console.log(chalk.yellow('⚠ No QA commands detected'));
        console.log(chalk.gray('  Add qa.commands to .blockspool/config.json to enable QA:'));
        console.log(chalk.gray('  {'));
        console.log(chalk.gray('    "qa": {'));
        console.log(chalk.gray('      "commands": ['));
        console.log(chalk.gray('        { "name": "lint", "cmd": "npm run lint" },'));
        console.log(chalk.gray('        { "name": "test", "cmd": "npm test" }'));
        console.log(chalk.gray('      ]'));
        console.log(chalk.gray('    }'));
        console.log(chalk.gray('  }'));
      }

      console.log();
      console.log('Next steps:');
      console.log('  blockspool solo scout .    Scan for improvement opportunities');
      console.log('  blockspool solo status     View local state');
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
        process.exitCode = 1;
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
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      const dir = getBlockspoolDir(repoRoot);
      const dbPathVal = getDbPath(repoRoot);

      if (!fs.existsSync(dir)) {
        console.log(chalk.gray('No local state to clear'));
        return;
      }

      if (!options.force) {
        console.log(chalk.yellow('⚠ This will delete all local BlockSpool data:'));
        console.log(chalk.gray(`  ${dir}`));
        console.log();
        console.log('Run with --force to confirm.');
        process.exit(1);
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
   * solo repos - List and manage authorized repositories
   */
  solo
    .command('repos')
    .description('List and manage authorized repositories')
    .option('--remove <remote>', 'Deauthorize a repo by remote URL or name')
    .option('--json', 'Output as JSON')
    .action(async (options: { remove?: string; json?: boolean }) => {
      if (options.remove) {
        // Try exact match first, then match by name
        let removed = deauthorizeRepo(options.remove);
        if (!removed) {
          const repos = listAuthorizedRepos();
          const byName = repos.find(r => r.name === options.remove || r.name.endsWith('/' + options.remove));
          if (byName) {
            removed = deauthorizeRepo(byName.remote);
          }
        }
        if (removed) {
          console.log(chalk.green(`✓ Deauthorized: ${options.remove}`));
        } else {
          console.log(chalk.red(`✗ Not found: ${options.remove}`));
          console.log(chalk.gray('  Run "blockspool solo repos" to see authorized repos'));
        }
        return;
      }

      const repos = listAuthorizedRepos();

      if (options.json) {
        console.log(JSON.stringify(repos, null, 2));
        return;
      }

      if (repos.length === 0) {
        console.log(chalk.gray('No authorized repos. Run "blockspool solo init" in a repo to authorize it.'));
        return;
      }

      console.log(chalk.bold(`Authorized repositories (${repos.length}):`));
      console.log();
      for (const repo of repos) {
        console.log(`  ${chalk.cyan(repo.name)}`);
        console.log(chalk.gray(`    Remote: ${repo.remote}`));
        console.log(chalk.gray(`    Path:   ${repo.localPath}`));
        console.log(chalk.gray(`    Since:  ${repo.authorizedAt}`));
        console.log();
      }
      console.log(chalk.gray('Remove with: blockspool solo repos --remove <name>'));
    });
}
