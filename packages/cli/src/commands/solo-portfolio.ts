/**
 * Portfolio command — view or reset the project portfolio.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { resolveRepoRootOrExit } from '../lib/command-runtime.js';
import { loadPortfolio, resetPortfolio, formatPortfolioForPrompt } from '../lib/portfolio.js';

export function registerPortfolioCommands(solo: Command): void {
  const portfolio = solo
    .command('portfolio')
    .description('View or manage the persistent project portfolio')
    .addHelpText('after', `
Examples:
  promptwheel portfolio          Show portfolio summary
  promptwheel portfolio reset    Delete portfolio file
`);

  portfolio
    .command('show', { isDefault: true })
    .description('Show the project portfolio')
    .action(async () => {
      const repoRoot = await resolveRepoRootOrExit();
      await showPortfolio(repoRoot);
    });

  portfolio
    .command('reset')
    .description('Delete the portfolio file')
    .action(async () => {
      const repoRoot = await resolveRepoRootOrExit();
      const deleted = resetPortfolio(repoRoot);
      if (deleted) {
        console.log(chalk.green('Portfolio reset.'));
      } else {
        console.log(chalk.yellow('No portfolio file found.'));
      }
    });
}

async function showPortfolio(repoRoot: string): Promise<void> {
  const portfolio = loadPortfolio(repoRoot);
  if (!portfolio) {
    console.log(chalk.yellow('No portfolio found. Run a session to generate one.'));
    return;
  }

  console.log(chalk.bold('Project Portfolio'));
  console.log(chalk.gray(`Last updated: ${portfolio.lastUpdated}`));
  console.log();

  // Architecture
  console.log(chalk.bold.cyan('Architecture'));
  console.log(`  Build system: ${portfolio.architecture.buildSystem}`);
  console.log(`  Test strategy: ${portfolio.architecture.testStrategy}`);
  if (portfolio.architecture.coreModules.length > 0) {
    console.log(`  Core modules: ${portfolio.architecture.coreModules.join(', ')}`);
  }
  console.log();

  // Hotspots
  if (portfolio.hotspots.length > 0) {
    console.log(chalk.bold.red('Hotspots'));
    for (const h of portfolio.hotspots.slice(0, 10)) {
      console.log(`  ${h.path} — ${h.failureCount} failure(s)`);
      if (h.commonErrors.length > 0) {
        console.log(chalk.gray(`    ${h.commonErrors.slice(0, 2).join(', ')}`));
      }
    }
    console.log();
  }

  // Patterns
  console.log(chalk.bold.green('Patterns'));
  console.log(`  Avg steps/trajectory: ${portfolio.patterns.avgStepsPerTrajectory}`);
  if (portfolio.patterns.preferredCategories.length > 0) {
    console.log(`  Best categories: ${portfolio.patterns.preferredCategories.join(', ')}`);
  }
  if (portfolio.patterns.avoidCategories.length > 0) {
    console.log(`  Low-success categories: ${portfolio.patterns.avoidCategories.join(', ')}`);
  }
  console.log();

  // Decisions
  if (portfolio.decisions.length > 0) {
    console.log(chalk.bold.yellow('Recent Decisions'));
    for (const d of portfolio.decisions.slice(-5)) {
      console.log(`  [${d.date}] ${d.summary}`);
    }
    console.log();
  }

  // Prompt preview
  console.log(chalk.gray('Scout prompt injection:'));
  console.log(chalk.gray(formatPortfolioForPrompt(portfolio)));
}
