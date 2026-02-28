/**
 * Export metrics as NDJSON for external observability tools.
 *
 * Usage:
 *   promptwheel export-metrics                  # All run history as NDJSON
 *   promptwheel export-metrics --since 7d       # Last 7 days
 *   promptwheel export-metrics --include events # Include raw event metrics
 *   promptwheel export-metrics > metrics.ndjson # Pipe to file
 *   promptwheel export-metrics | jq .           # Pipe to jq
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';

export function registerExportMetricsCommand(solo: Command): void {
  solo
    .command('export-metrics')
    .description('Export session metrics as NDJSON for external analysis')
    .option('--since <duration>', 'Only include entries since duration (e.g. 7d, 24h, 30m)')
    .option('--include <types>', 'Include additional data: events, tickets, all (comma-separated)')
    .option('-n, --limit <n>', 'Maximum entries to export')
    .action(async (options: {
      since?: string;
      include?: string;
      limit?: string;
    }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      const includeSet = new Set(
        (options.include ?? '').split(',').map(s => s.trim()).filter(Boolean),
      );
      const includeAll = includeSet.has('all');
      const includeEvents = includeAll || includeSet.has('events');
      const includeTickets = includeAll || includeSet.has('tickets');

      const sinceMs = options.since ? parseDuration(options.since) : undefined;
      const cutoff = sinceMs ? Date.now() - sinceMs : undefined;
      const limit = options.limit ? parseInt(options.limit, 10) : undefined;

      // Export run history as NDJSON (one JSON object per line)
      const { readRunHistory } = await import('../lib/run-history.js');
      const entries = readRunHistory(repoRoot, limit);

      let exported = 0;
      for (const entry of entries) {
        // Apply time filter
        if (cutoff) {
          const entryTime = new Date(entry.timestamp).getTime();
          if (entryTime < cutoff) continue;
        }

        const record: Record<string, unknown> = {
          type: 'run',
          timestamp: entry.timestamp,
          mode: entry.mode,
          scope: entry.scope,
          formula: entry.formula,
          durationMs: entry.durationMs,
          ticketsProposed: entry.ticketsProposed,
          ticketsCompleted: entry.ticketsCompleted,
          ticketsFailed: entry.ticketsFailed,
          prsCreated: entry.prsCreated,
          prsMerged: entry.prsMerged,
          stoppedReason: entry.stoppedReason,
        };

        if (entry.phaseTiming) {
          record.phaseTiming = entry.phaseTiming;
        }
        if (entry.tokenUsage) {
          record.tokenUsage = entry.tokenUsage;
        }
        if (entry.drillStats) {
          record.drillStats = entry.drillStats;
        }
        if (includeTickets && entry.tickets) {
          record.tickets = entry.tickets;
        }

        process.stdout.write(JSON.stringify(record) + '\n');
        exported++;
      }

      // Optionally include raw event metrics
      if (includeEvents) {
        try {
          const { readMetrics } = await import('../lib/metrics.js');
          const events = readMetrics(repoRoot);
          for (const event of events) {
            if (cutoff && event.timestamp < cutoff) continue;
            process.stdout.write(JSON.stringify({
              type: 'event',
              system: event.system,
              event: event.event,
              timestamp: new Date(event.timestamp).toISOString(),
              data: event.data,
            }) + '\n');
            exported++;
          }
        } catch {
          // Metrics file may not exist — non-fatal
        }
      }

      // Write summary to stderr (so stdout stays clean NDJSON)
      if (exported === 0) {
        process.stderr.write('No metrics data found.\n');
      } else {
        process.stderr.write(`Exported ${exported} record(s)\n`);
      }
    });
}

/**
 * Parse a human-readable duration string to milliseconds.
 * Supports: 30m, 24h, 7d
 */
function parseDuration(input: string): number | undefined {
  const trimmed = input.trim().toLowerCase();
  const unit = trimmed.charAt(trimmed.length - 1);
  if (unit !== 'm' && unit !== 'h' && unit !== 'd') return undefined;
  const value = parseFloat(trimmed.slice(0, -1));
  if (isNaN(value) || value <= 0) return undefined;

  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return undefined;
  }
}
