/**
 * Dead code detection and structural issue analysis.
 *
 * Cross-module export-import matching to find unused exports and
 * structural anti-patterns. Pure functions — no I/O.
 */

import type {
  ModuleEntry,
  DeadExportEntry,
  StructuralIssue,
  ExportEntry,
} from './shared.js';

// ---------------------------------------------------------------------------
// Dead export detection
// ---------------------------------------------------------------------------

/**
 * Detect potentially dead exports by comparing each module's exported names
 * against what other modules import. Uses name-based matching (no type
 * resolution) — sufficient for high-confidence identification.
 *
 * Returns at most `maxResults` entries to keep prompt token count bounded.
 */
export function detectDeadExports(
  modules: ModuleEntry[],
  edges: Record<string, string[]>,
  exportsByModule: Record<string, ExportEntry[]>,
  importsByModule: Record<string, string[]>,
  maxResults = 30,
): DeadExportEntry[] {
  // Build a set of all imported names across all modules
  const allImportedNames = new Set<string>();
  for (const imports of Object.values(importsByModule)) {
    for (const spec of imports) {
      // Extract the imported name from the specifier
      // For relative imports like './foo', the actual imported names come from
      // import { X } statements — we only have specifiers, not destructured names.
      // So we use a heuristic: mark the last segment of the path as "used"
      const parts = spec.split('/');
      const lastPart = parts[parts.length - 1];
      if (lastPart) allImportedNames.add(lastPart);
      // Also add the full specifier for exact matches
      allImportedNames.add(spec);
    }
  }

  // For each module with exports, check if any export name is never imported
  const dead: DeadExportEntry[] = [];

  for (const mod of modules) {
    if (dead.length >= maxResults) break;
    const exports = exportsByModule[mod.path];
    if (!exports || exports.length === 0) continue;

    // Skip if this module has no dependents (everything would be "dead")
    // — the whole module might be an entrypoint
    const hasImporters = Object.values(edges).some(deps => deps.includes(mod.path));
    if (!hasImporters) continue;

    for (const exp of exports) {
      if (dead.length >= maxResults) break;
      // Skip 'default' — too noisy, often used implicitly
      if (exp.name === 'default') continue;
      // Skip type exports — they're erased at runtime and aren't a real concern
      if (exp.kind === 'type' || exp.kind === 'interface') continue;

      // Check if this name appears in any import specifier
      if (!allImportedNames.has(exp.name)) {
        dead.push({ module: mod.path, name: exp.name, kind: exp.kind });
      }
    }
  }

  return dead;
}

// ---------------------------------------------------------------------------
// Structural issue detection
// ---------------------------------------------------------------------------

/**
 * Detect structural anti-patterns from dependency graph topology.
 *
 * Patterns detected:
 * - god-module: fan_in > 5 AND file_count > 20
 * - excessive-fan-out: fan_out > 8
 * - barrel-only: 1 file that exists only to re-export
 * - orphan: zero in/out edges, not an entrypoint
 *
 * Returns at most `maxResults` entries.
 */
export function detectStructuralIssues(
  modules: ModuleEntry[],
  edges: Record<string, string[]>,
  reverseEdges: Record<string, string[]>,
  cycles: string[][],
  entrypoints: string[] = [],
  maxResults = 15,
): StructuralIssue[] {
  const issues: StructuralIssue[] = [];
  const entrypointDirs = new Set(entrypoints.map(e => e.split('/').slice(0, -1).join('/')));

  // Circular dependencies (from pre-computed cycles)
  for (const cycle of cycles) {
    if (issues.length >= maxResults) break;
    const display = cycle.join(' → ');
    issues.push({
      kind: 'circular-dep',
      module: cycle[0],
      detail: display,
      severity: 'warning',
    });
  }

  for (const mod of modules) {
    if (issues.length >= maxResults) break;
    const fanIn = (reverseEdges[mod.path] ?? []).length;
    const fanOut = (edges[mod.path] ?? []).length;

    // God module: many dependents + many files
    if (fanIn > 5 && mod.file_count > 20) {
      issues.push({
        kind: 'god-module',
        module: mod.path,
        detail: `fan-in: ${fanIn}, ${mod.file_count} files`,
        severity: 'warning',
      });
    }

    // Excessive fan-out
    if (fanOut > 8) {
      issues.push({
        kind: 'excessive-fan-out',
        module: mod.path,
        detail: `imports ${fanOut} modules`,
        severity: 'info',
      });
    }

    // Barrel-only: 1 file, has exports but is just re-exporting
    if (mod.file_count === 1 && fanOut > 0 && fanIn > 0 && (mod.export_count ?? 0) > 0) {
      // Heuristic: barrel if export_count > 0 and it imports from multiple modules
      if (fanOut >= 2) {
        issues.push({
          kind: 'barrel-only',
          module: mod.path,
          detail: `1 file, re-exports from ${fanOut} modules`,
          severity: 'info',
        });
      }
    }

    // Orphan: no edges, not an entrypoint
    if (fanIn === 0 && fanOut === 0 && !entrypointDirs.has(mod.path) && mod.production) {
      issues.push({
        kind: 'orphan',
        module: mod.path,
        detail: 'no dependencies',
        severity: 'info',
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Coupling metrics (Martin's instability)
// ---------------------------------------------------------------------------

export interface CouplingMetrics {
  /** Per-module instability: Ce / (Ca + Ce). High = easily affected by change. */
  instability: Record<string, number>;
}

/**
 * Compute Robert C. Martin's instability metric per module.
 * I = Ce / (Ca + Ce) where:
 * - Ca (afferent coupling) = fan_in (who depends on me)
 * - Ce (efferent coupling) = fan_out (who I depend on)
 * - I = 0: maximally stable (many dependents, no dependencies)
 * - I = 1: maximally unstable (no dependents, many dependencies)
 */
export function computeCouplingMetrics(
  modules: ModuleEntry[],
  edges: Record<string, string[]>,
  reverseEdges: Record<string, string[]>,
): CouplingMetrics {
  const instability: Record<string, number> = {};

  for (const mod of modules) {
    const ca = (reverseEdges[mod.path] ?? []).length; // afferent
    const ce = (edges[mod.path] ?? []).length;         // efferent
    const total = ca + ce;
    instability[mod.path] = total > 0 ? ce / total : 0;
  }

  return { instability };
}
