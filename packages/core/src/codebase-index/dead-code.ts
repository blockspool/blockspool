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
  CallEdge,
  TypeScriptAnalysis,
} from './shared.js';

// ---------------------------------------------------------------------------
// Dead export detection
// ---------------------------------------------------------------------------

/**
 * Detect potentially dead exports by comparing each module's exported names
 * against what other modules import.
 *
 * When `importedBindings` is provided (from AST cache's importedNames), uses
 * accurate binding name matching. Otherwise falls back to specifier path
 * heuristic (less accurate but works without AST data).
 *
 * `namespaceSpecifiers` contains specifier paths that have `import * as ns`
 * usage — all exports from those modules are considered alive.
 *
 * Returns at most `maxResults` entries to keep prompt token count bounded.
 */
export function detectDeadExports(
  modules: ModuleEntry[],
  edges: Record<string, string[]>,
  exportsByModule: Record<string, ExportEntry[]>,
  importsByModule: Record<string, string[]>,
  maxResults = 30,
  importedBindings?: Set<string>,
  namespaceSpecifiers?: Set<string>,
): DeadExportEntry[] {
  // Build a set of all imported names across all modules
  // Prefer accurate binding names when available; fall back to specifier heuristic
  const allImportedNames = importedBindings ?? new Set<string>();
  if (!importedBindings) {
    for (const imports of Object.values(importsByModule)) {
      for (const spec of imports) {
        // Fallback heuristic: mark the last path segment as "used"
        const parts = spec.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart) allImportedNames.add(lastPart);
        allImportedNames.add(spec);
      }
    }
  }

  // Build set of module paths that have namespace imports (all exports alive)
  const nsModulePaths = new Set<string>();
  if (namespaceSpecifiers && namespaceSpecifiers.size > 0) {
    for (const mod of modules) {
      // Check if any namespace specifier resolves to this module
      for (const spec of namespaceSpecifiers) {
        // Heuristic: specifier ends with the module's last path segment
        const modBasename = mod.path.split('/').pop();
        if (modBasename && (spec.endsWith(modBasename) || spec.endsWith(`/${mod.path}`))) {
          nsModulePaths.add(mod.path);
        }
      }
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

    // Skip modules with namespace imports — all their exports are used
    if (nsModulePaths.has(mod.path)) continue;

    for (const exp of exports) {
      if (dead.length >= maxResults) break;
      // Skip 'default' — too noisy, often used implicitly
      if (exp.name === 'default') continue;
      // Skip type exports — they're erased at runtime and aren't a real concern
      if (exp.kind === 'type' || exp.kind === 'interface') continue;

      // Check if this name appears in any imported binding
      if (!allImportedNames.has(exp.name)) {
        dead.push({ module: mod.path, name: exp.name, kind: exp.kind });
      }
    }
  }

  return dead;
}

// ---------------------------------------------------------------------------
// Dead function detection (call-graph-enhanced)
// ---------------------------------------------------------------------------

/**
 * Detect exported functions that are never called by any other file.
 * Uses call edge data from the AST cache for higher-confidence results
 * than name-based matching alone.
 *
 * Only flags functions — skips classes, types, variables, and constants
 * since those may be used without explicit "call" edges.
 */
export function detectDeadFunctions(
  exportsByFile: Record<string, ExportEntry[]>,
  callEdgesByFile: Record<string, CallEdge[]>,
  maxResults = 20,
): DeadExportEntry[] {
  // Build set of all callee names across all files (cross-file calls)
  const allCallees = new Set<string>();
  for (const edges of Object.values(callEdgesByFile)) {
    for (const edge of edges) {
      if (edge.importSource) {
        allCallees.add(edge.callee);
      }
    }
  }

  const dead: DeadExportEntry[] = [];
  for (const [file, exports] of Object.entries(exportsByFile)) {
    if (dead.length >= maxResults) break;
    for (const exp of exports) {
      if (dead.length >= maxResults) break;
      // Only flag function exports — other kinds may be consumed without calls
      if (exp.kind !== 'function') continue;
      if (exp.name === 'default') continue;
      if (!allCallees.has(exp.name)) {
        // Extract module path from file path (directory containing the file)
        const mod = file.split('/').slice(0, -1).join('/') || '.';
        dead.push({ module: mod, name: exp.name, kind: exp.kind });
      }
    }
  }

  return dead;
}

// ---------------------------------------------------------------------------
// Fused call graph (ast-grep + ts-morph)
// ---------------------------------------------------------------------------

/**
 * Merge ast-grep per-file call edges with ts-morph global call_graph_edges
 * into a unified set of cross-file callee names.
 *
 * ts-morph edges use format `"path:funcName"` for caller and raw expression
 * text for callee. ast-grep edges have `importSource` for cross-file calls.
 * The fused result is a superset: any function name that appears as a callee
 * in either source is considered "called".
 *
 * Returns a Set of callee names that are called from other files.
 */
export function fuseCallGraphs(
  callEdgesByFile: Record<string, CallEdge[]>,
  tsAnalysis?: TypeScriptAnalysis | null,
): Set<string> {
  const allCallees = new Set<string>();

  // 1. ast-grep: cross-file calls (callee imported from another file)
  for (const edges of Object.values(callEdgesByFile)) {
    for (const edge of edges) {
      if (edge.importSource) {
        allCallees.add(edge.callee);
      }
    }
  }

  // 2. ts-morph: call_graph_edges provide type-resolved calls
  if (tsAnalysis?.call_graph_edges) {
    for (const edge of tsAnalysis.call_graph_edges) {
      // callee format is raw expression text, e.g. "validateToken", "this.service.call"
      // Extract the last identifier segment for matching
      const callee = edge.callee;
      // Simple identifiers match directly
      if (/^[a-zA-Z_$][\w$]*$/.test(callee)) {
        allCallees.add(callee);
      } else {
        // For method calls like "foo.bar()", extract "bar"
        const dotMatch = callee.match(/\.(\w+)$/);
        if (dotMatch) {
          allCallees.add(dotMatch[1]);
        }
      }
    }
  }

  return allCallees;
}

/**
 * Enhanced dead function detection using fused call graph data.
 * Combines ast-grep per-file edges with ts-morph global edges to reduce
 * false positives (functions marked dead because ast-grep missed type-resolved calls).
 */
export function detectDeadFunctionsFused(
  exportsByFile: Record<string, ExportEntry[]>,
  callEdgesByFile: Record<string, CallEdge[]>,
  tsAnalysis?: TypeScriptAnalysis | null,
  maxResults = 20,
): DeadExportEntry[] {
  const allCallees = fuseCallGraphs(callEdgesByFile, tsAnalysis);

  const dead: DeadExportEntry[] = [];
  for (const [file, exports] of Object.entries(exportsByFile)) {
    if (dead.length >= maxResults) break;
    for (const exp of exports) {
      if (dead.length >= maxResults) break;
      if (exp.kind !== 'function') continue;
      if (exp.name === 'default') continue;
      if (!allCallees.has(exp.name)) {
        const mod = file.split('/').slice(0, -1).join('/') || '.';
        dead.push({ module: mod, name: exp.name, kind: exp.kind });
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
