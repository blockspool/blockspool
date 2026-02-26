import { Command } from 'commander';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';

export function registerInspectFormulasCommand(solo: Command): void {
  solo
    .command('formulas')
    .description('List available auto formulas')
    .action(async () => {
      const { listFormulas } = await import('../lib/formulas.js');
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());
      const formulas = listFormulas(repoRoot || undefined);

      if (formulas.length === 0) {
        console.log(chalk.gray('No formulas available'));
        return;
      }

      console.log(chalk.bold('Available formulas:\n'));
      for (const formula of formulas) {
        const tags = formula.tags?.length ? chalk.gray(` [${formula.tags.join(', ')}]`) : '';
        console.log(`  ${chalk.cyan(formula.name)}${tags}`);
        console.log(`    ${formula.description}`);
        if (formula.categories?.length) {
          console.log(chalk.gray(`    Categories: ${formula.categories.join(', ')}`));
        }
        if (formula.minConfidence) {
          console.log(chalk.gray(`    Min confidence: ${formula.minConfidence}%`));
        }
        console.log();
      }

      console.log(chalk.gray('Usage: promptwheel solo auto --formula <name>'));
      console.log(chalk.gray('Custom: Create .promptwheel/formulas/<name>.yaml'));
    });
}
