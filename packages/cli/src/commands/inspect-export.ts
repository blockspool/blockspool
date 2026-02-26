import { Command } from 'commander';
import * as fs from 'node:fs';
import chalk from 'chalk';
import { projects, tickets, runs } from '@promptwheel/core/repos';
import { resolveRepoRootOrExit, withCommandAdapter } from '../lib/command-runtime.js';

export function registerInspectExportCommand(solo: Command): void {
  solo
    .command('export')
    .description('Export local state for debugging or migration')
    .option('-o, --output <file>', 'Output file', 'promptwheel-export.json')
    .action(async (options: { output: string }) => {
      const repoRoot = await resolveRepoRootOrExit();
      await withCommandAdapter(repoRoot, async (adapter) => {
        const projectList = await projects.list(adapter);

        const data: Record<string, unknown> = {
          exportedAt: new Date().toISOString(),
          version: 1,
          projects: [],
        };

        for (const project of projectList) {
          const projectTickets = await tickets.listByProject(adapter, project.id);
          const projectRuns = await runs.listByProject(adapter, project.id);

          (data.projects as unknown[]).push({
            ...project,
            tickets: projectTickets,
            runs: projectRuns,
          });
        }

        try {
          const { loadDrillHistory } = await import('../lib/solo-auto-drill.js');
          const { loadTrajectoryState } = await import('../lib/trajectory.js');
          const drillData = loadDrillHistory(repoRoot);
          const trajectoryState = loadTrajectoryState(repoRoot);
          if (drillData.entries.length > 0 || trajectoryState) {
            data.drill = {
              history: drillData.entries,
              coveredCategories: drillData.coveredCategories,
              coveredScopes: drillData.coveredScopes,
              activeTrajectory: trajectoryState ?? null,
            };
          }
        } catch {
          // Non-fatal
        }

        fs.writeFileSync(options.output, JSON.stringify(data, null, 2));
        console.log(chalk.green(`✓ Exported to ${options.output}`));
      });
    });
}
