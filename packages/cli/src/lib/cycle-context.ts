/**
 * Cycle context for scout prompting.
 *
 * Tracks recent cycle outcomes so the scout can propose follow-up work
 * instead of random scattershot.
 */

// ---------------------------------------------------------------------------
// Cycle Summary
// ---------------------------------------------------------------------------

export interface CycleSummary {
  cycle: number;
  scope: string;
  formula: string;
  succeeded: Array<{ title: string; category: string }>;
  failed: Array<{ title: string; reason: string }>;
  noChanges: string[];
}

/**
 * Build an XML block summarizing recent cycle outcomes for the scout prompt.
 * Optionally includes recent diff summaries for follow-up awareness.
 */
export function buildCycleContextBlock(
  recentCycles: CycleSummary[],
  recentDiffs?: Array<{ title: string; summary: string; files: string[]; cycle: number }>,
): string {
  if ((!recentCycles || recentCycles.length === 0) && (!recentDiffs || recentDiffs.length === 0)) return '';

  const lines: string[] = ['<recent-cycles>', '## Recent Cycle Outcomes', ''];

  for (const c of (recentCycles ?? [])) {
    lines.push(`### Cycle ${c.cycle} — scope: ${c.scope}, formula: ${c.formula}`);
    if (c.succeeded.length > 0) {
      lines.push('Succeeded:');
      for (const s of c.succeeded) {
        lines.push(`- [${s.category}] ${s.title}`);
      }
    }
    if (c.failed.length > 0) {
      lines.push('Failed:');
      for (const f of c.failed) {
        lines.push(`- ${f.title} (${f.reason})`);
      }
    }
    if (c.noChanges.length > 0) {
      lines.push('No changes produced:');
      for (const nc of c.noChanges) {
        lines.push(`- ${nc}`);
      }
    }
    lines.push('');
  }

  // Append recent diffs for follow-up awareness
  if (recentDiffs && recentDiffs.length > 0) {
    lines.push('<recent-diffs>');
    for (const d of recentDiffs.slice(-5)) {
      lines.push(`Title: "${d.title}", Files: [${d.files.join(', ')}], Changes: ${d.summary}`);
    }
    lines.push('Consider proposing follow-up work based on these recent changes.');
    lines.push('</recent-diffs>');
    lines.push('');
  }

  lines.push('Use these outcomes to propose FOLLOW-UP work.');
  lines.push('Fix what failed. Build on what succeeded. Avoid repeating no-change proposals.');
  lines.push('</recent-cycles>');

  return lines.join('\n');
}

/**
 * Ring buffer push — keeps at most `max` entries.
 */
export function pushCycleSummary(
  buf: CycleSummary[],
  summary: CycleSummary,
  max: number = 5,
): CycleSummary[] {
  const result = [...buf, summary];
  if (result.length > max) {
    return result.slice(result.length - max);
  }
  return result;
}

