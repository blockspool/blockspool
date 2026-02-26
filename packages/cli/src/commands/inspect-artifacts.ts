import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import chalk from 'chalk';
import type { ArtifactType } from '../lib/artifacts.js';
import { getPromptwheelDir } from '../lib/solo-config.js';
import {
  DEFAULT_INSPECT_ARTIFACT_TYPES,
  buildArtifactsByTypeJson,
  buildArtifactsForRunJson,
  listArtifactsForRun,
} from '../lib/inspect-status-service.js';

export function registerInspectArtifactsCommand(solo: Command): void {
  solo
    .command('artifacts')
    .description('List and view run artifacts')
    .option('--run <runId>', 'Show artifacts for a specific run')
    .option('--type <type>', 'Filter by artifact type (proposals, executions, diffs, runs, violations)')
    .option('--show <path>', 'Display contents of a specific artifact file')
    .option('--json', 'Output in JSON format')
    .action(async (options: {
      run?: string;
      type?: string;
      show?: string;
      json?: boolean;
    }) => {
      const repoRoot = process.cwd();
      const baseDir = getPromptwheelDir(repoRoot);
      const artifactsDir = path.join(baseDir, 'artifacts');

      if (options.show) {
        const filePath = options.show.startsWith('/') ? options.show : path.join(process.cwd(), options.show);
        if (!fs.existsSync(filePath)) {
          console.error(chalk.red(`Artifact not found: ${filePath}`));
          process.exit(1);
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        if (options.json) {
          console.log(content);
        } else {
          console.log(chalk.cyan(`\n─── ${path.basename(filePath)} ───\n`));
          try {
            const data = JSON.parse(content);
            console.log(JSON.stringify(data, null, 2));
          } catch {
            console.log(content);
          }
        }
        return;
      }

      if (options.run) {
        const found = listArtifactsForRun(baseDir, options.run);

        if (options.json) {
          console.log(JSON.stringify(buildArtifactsForRunJson(baseDir, options.run), null, 2));
          return;
        }

        if (found.length === 0) {
          console.log(chalk.yellow(`No artifacts found for run: ${options.run}`));
          return;
        }

        console.log(chalk.cyan(`\nArtifacts for run ${options.run}:\n`));
        for (const artifact of found) {
          console.log(`  ${chalk.bold(artifact.type)}: ${artifact.path}`);
        }
        console.log();
        return;
      }

      if (!fs.existsSync(artifactsDir)) {
        console.log(chalk.yellow('No artifacts found. Run a ticket to generate artifacts.'));
        return;
      }

      const types: ArtifactType[] = options.type
        ? [options.type as ArtifactType]
        : DEFAULT_INSPECT_ARTIFACT_TYPES;

      const output = buildArtifactsByTypeJson(baseDir, types);
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      let totalCount = 0;
      for (const type of types) {
        const artifacts = output[type] ?? [];
        if (artifacts.length === 0) continue;

        console.log(chalk.cyan(`\n${type.toUpperCase()} (${artifacts.length}):`));
        for (const artifact of artifacts.slice(0, 10)) {
          const date = new Date(artifact.timestamp).toISOString().slice(0, 19).replace('T', ' ');
          console.log(`  ${chalk.gray(date)}  ${artifact.id}`);
          console.log(`    ${chalk.dim(artifact.path)}`);
          totalCount++;
        }
        if (artifacts.length > 10) {
          console.log(chalk.dim(`    ... and ${artifacts.length - 10} more`));
        }
      }

      if (totalCount === 0) {
        console.log(chalk.yellow('No artifacts found. Run a ticket to generate artifacts.'));
      } else {
        console.log(chalk.dim('\nUse --show <path> to view an artifact, or --run <id> to see all artifacts for a run.\n'));
      }
    });
}
