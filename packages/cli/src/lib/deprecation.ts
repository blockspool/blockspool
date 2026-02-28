/**
 * One-shot deprecation warnings for legacy CLI flags.
 *
 * Call `warnDeprecatedFlags(options)` once per session.
 * Prints a yellow warning for each deprecated flag that was used,
 * with guidance on the modern replacement.
 */

import chalk from 'chalk';

interface DeprecatedFlag {
  /** camelCase key as it appears on the options object */
  key: string;
  /** CLI flag name for display */
  flag: string;
  /** What to use instead */
  replacement: string;
}

/**
 * Each entry maps a deprecated flag to its replacement guidance.
 * `defaultVal` entries (like --draft=true) need special detection;
 * we only warn when the user *explicitly* set the flag.
 */
const DEPRECATED_FLAGS: DeprecatedFlag[] = [
  { key: 'minutes', flag: '--minutes', replacement: 'use --hours (accepts decimals: --hours 0.5 = 30min)' },
  { key: 'cycles', flag: '--cycles', replacement: 'cycles are managed automatically in spin mode' },
  { key: 'maxPrs', flag: '--max-prs', replacement: 'PR limit is handled automatically; use --hours for time budgets' },
  { key: 'branch', flag: '--branch', replacement: 'branch naming is handled automatically' },
  { key: 'individualPrs', flag: '--individual-prs', replacement: 'this is now the default behavior' },
  { key: 'scoutBackend', flag: '--scout-backend', replacement: 'use --provider (e.g. --provider codex)' },
  { key: 'executeBackend', flag: '--execute-backend', replacement: 'use --provider (e.g. --provider claude)' },
  { key: 'codexModel', flag: '--codex-model', replacement: 'model selection is automatic' },
  { key: 'kimiModel', flag: '--kimi-model', replacement: 'model selection is automatic' },
  { key: 'codexUnsafeFullAccess', flag: '--codex-unsafe-full-access', replacement: 'sandbox is always enabled' },
  { key: 'includeClaudeMd', flag: '--include-claude-md', replacement: 'guidelines (CLAUDE.md) are always included' },
  { key: 'batchTokenBudget', flag: '--batch-token-budget', replacement: 'token budgets are managed automatically' },
  { key: 'scoutTimeout', flag: '--scout-timeout', replacement: 'timeouts are managed automatically' },
  { key: 'maxScoutFiles', flag: '--max-scout-files', replacement: 'file limits are managed automatically' },
  { key: 'scoutConcurrency', flag: '--scout-concurrency', replacement: 'concurrency is managed automatically' },
  { key: 'codexMcp', flag: '--codex-mcp', replacement: 'MCP mode is no longer supported; use --provider codex' },
  { key: 'localMaxIterations', flag: '--local-max-iterations', replacement: 'iteration limits are managed automatically' },
  { key: 'docsAuditInterval', flag: '--docs-audit-interval', replacement: 'docs auditing cadence is automatic' },
  { key: 'autoMerge', flag: '--auto-merge', replacement: 'use --pr for pull requests' },
  { key: 'directBranch', flag: '--direct-branch', replacement: 'branch naming is handled automatically' },
  { key: 'directFinalize', flag: '--direct-finalize', replacement: 'finalization mode is selected automatically' },
];

/**
 * Boolean flags with defaults need special handling:
 * --no-draft → draft === false, --no-docs-audit → docsAudit === false
 */
const DEPRECATED_BOOLEAN_FLAGS: Array<DeprecatedFlag & { triggerValue: boolean }> = [
  { key: 'draft', flag: '--no-draft', replacement: 'drafts are the default; use --pr for pull requests', triggerValue: false },
  { key: 'docsAudit', flag: '--no-docs-audit', replacement: 'docs auditing is always on', triggerValue: false },
];

/**
 * Print deprecation warnings for any legacy flags present in the options object.
 * Designed to be called once per session, early in the action handler.
 *
 * Returns the count of deprecated flags found (useful for testing).
 */
export function warnDeprecatedFlags(options: Record<string, unknown>): number {
  const warnings: string[] = [];

  for (const { key, flag, replacement } of DEPRECATED_FLAGS) {
    if (options[key] !== undefined && options[key] !== null) {
      warnings.push(`${flag} is deprecated — ${replacement}`);
    }
  }

  for (const { key, flag, replacement, triggerValue } of DEPRECATED_BOOLEAN_FLAGS) {
    if (options[key] === triggerValue) {
      warnings.push(`${flag} is deprecated — ${replacement}`);
    }
  }

  if (warnings.length > 0) {
    console.log(chalk.yellow(`⚠ ${warnings.length} deprecated flag${warnings.length > 1 ? 's' : ''}:`));
    for (const w of warnings) {
      console.log(chalk.yellow(`  • ${w}`));
    }
    console.log(chalk.gray('  These flags will be removed in a future release.'));
    console.log();
  }

  return warnings.length;
}
