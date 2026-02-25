/**
 * Format analysis data (dead exports, structural issues, graph insights,
 * TS analysis) into a compact prompt block for the scout.
 *
 * Rotates sections by cycle number to stay within ~800 token budget per cycle.
 * Pure function — no I/O.
 */

import type {
  CodebaseIndex,
  DeadExportEntry,
  StructuralIssue,
  TypeScriptAnalysis,
} from './shared.js';

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function formatDeadExports(dead: DeadExportEntry[]): string {
  if (dead.length === 0) return '';

  // Group by module
  const byModule = new Map<string, string[]>();
  for (const d of dead) {
    const names = byModule.get(d.module) ?? [];
    names.push(d.name);
    byModule.set(d.module, names);
  }

  const lines: string[] = [`### Dead Exports (${dead.length} potentially unused)`];
  for (const [mod, names] of byModule) {
    lines.push(`${mod}: ${names.join(', ')}`);
  }
  return lines.join('\n');
}

function formatStructuralIssues(issues: StructuralIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = ['### Structural Issues'];
  for (const issue of issues) {
    lines.push(`- ${issue.kind}: ${issue.module} — ${issue.detail} (${issue.severity})`);
  }
  return lines.join('\n');
}

function formatGraphInsights(index: CodebaseIndex): string {
  const parts: string[] = [];

  if (index.graph_metrics) {
    const { hub_modules, orphan_modules, leaf_modules } = index.graph_metrics;
    if (hub_modules.length > 0) {
      parts.push(`Hub modules (3+ dependents): ${hub_modules.join(', ')}`);
    }
    if (leaf_modules.length > 0) {
      parts.push(`Leaf modules (no dependents): ${leaf_modules.slice(0, 8).join(', ')}`);
    }
    if (orphan_modules.length > 0) {
      parts.push(`Orphan modules: ${orphan_modules.slice(0, 5).join(', ')}`);
    }
  }

  if (index.dependency_cycles && index.dependency_cycles.length > 0) {
    const formatted = index.dependency_cycles
      .slice(0, 5)
      .map(c => c.join(' → '));
    parts.push(`Circular dependencies: ${formatted.join('; ')}`);
  }

  if (parts.length === 0) return '';
  return ['### Graph Topology', ...parts].join('\n');
}

function formatCouplingInsights(index: CodebaseIndex): string {
  // Extract instability extremes from modules
  const modules = index.modules;
  const edges = index.dependency_edges;
  const reverse = index.reverse_edges ?? {};

  const unstable: string[] = [];
  const stable: string[] = [];

  for (const mod of modules) {
    if (!mod.production) continue;
    const ca = (reverse[mod.path] ?? []).length;
    const ce = (edges[mod.path] ?? []).length;
    const total = ca + ce;
    if (total === 0) continue;
    const instability = ce / total;
    if (instability >= 0.9) unstable.push(mod.path);
    else if (instability <= 0.1 && ca >= 2) stable.push(mod.path);
  }

  if (unstable.length === 0 && stable.length === 0) return '';

  const parts: string[] = ['### Coupling Analysis'];
  if (unstable.length > 0) {
    parts.push(`Most unstable (easy to change, few dependents): ${unstable.slice(0, 5).join(', ')}`);
  }
  if (stable.length > 0) {
    parts.push(`Most stable (many dependents, hard to change safely): ${stable.slice(0, 5).join(', ')}`);
  }
  return parts.join('\n');
}

function formatTypeScriptAnalysis(ts: TypeScriptAnalysis): string {
  const parts: string[] = ['### TypeScript Quality'];

  parts.push(`any-count: ${ts.any_count}, type assertions: ${ts.unchecked_type_assertions}`);

  if (ts.any_propagation_paths.length > 0) {
    const worst = ts.any_propagation_paths
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    for (const p of worst) {
      parts.push(`any propagation: ${p.source} → ${p.reaches.join(', ')} (${p.length} hop${p.length !== 1 ? 's' : ''})`);
    }
  }

  // API surface summary — just top 5 by export count
  const surfaceEntries = Object.entries(ts.api_surface)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  if (surfaceEntries.length > 0) {
    parts.push(`Largest API surfaces: ${surfaceEntries.map(([m, c]) => `${m} (${c})`).join(', ')}`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * All available analysis sections, in display priority order.
 */
const SECTIONS = [
  'dead-exports',
  'structural',
  'graph',
  'coupling',
  'typescript',
] as const;

type SectionKey = (typeof SECTIONS)[number];

/**
 * Format analysis data for scout prompt injection.
 *
 * Rotates which sections are included based on `scoutCycle` to keep token
 * count bounded (~800 tokens max). Each cycle shows 2-3 sections.
 *
 * Returns `null` if no analysis data is available.
 */
export function formatAnalysisForPrompt(
  index: CodebaseIndex,
  scoutCycle: number,
): string | null {
  // Render all sections
  const rendered = new Map<SectionKey, string>();

  if (index.dead_exports && index.dead_exports.length > 0) {
    const s = formatDeadExports(index.dead_exports);
    if (s) rendered.set('dead-exports', s);
  }

  if (index.structural_issues && index.structural_issues.length > 0) {
    const s = formatStructuralIssues(index.structural_issues);
    if (s) rendered.set('structural', s);
  }

  {
    const s = formatGraphInsights(index);
    if (s) rendered.set('graph', s);
  }

  {
    const s = formatCouplingInsights(index);
    if (s) rendered.set('coupling', s);
  }

  if (index.typescript_analysis && (index.typescript_analysis.any_count > 0 || index.typescript_analysis.unchecked_type_assertions > 0)) {
    const s = formatTypeScriptAnalysis(index.typescript_analysis);
    if (s) rendered.set('typescript', s);
  }

  if (rendered.size === 0) return null;

  // If 3 or fewer sections, show all (fits in budget)
  if (rendered.size <= 3) {
    const parts = ['## Codebase Analysis'];
    for (const key of SECTIONS) {
      const content = rendered.get(key);
      if (content) parts.push(content);
    }
    return parts.join('\n\n');
  }

  // Rotate: show 3 sections per cycle
  const available = SECTIONS.filter(k => rendered.has(k));
  const windowSize = 3;
  const start = (scoutCycle * windowSize) % available.length;
  const selected = new Set<SectionKey>();
  for (let i = 0; i < windowSize && i < available.length; i++) {
    selected.add(available[(start + i) % available.length]);
  }

  const parts = ['## Codebase Analysis'];
  for (const key of SECTIONS) {
    if (selected.has(key)) {
      const content = rendered.get(key);
      if (content) parts.push(content);
    }
  }
  return parts.join('\n\n');
}
