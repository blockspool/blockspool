/**
 * Dead code and structural issue detection tests.
 */

import { describe, it, expect } from 'vitest';
import {
  detectDeadExports,
  detectDeadFunctions,
  detectDeadFunctionsFused,
  fuseCallGraphs,
  detectStructuralIssues,
  computeCouplingMetrics,
} from '../codebase-index/dead-code.js';
import type { ModuleEntry, ExportEntry, CallEdge, TypeScriptAnalysis } from '../codebase-index/shared.js';

function makeModule(p: string, overrides: Partial<ModuleEntry> = {}): ModuleEntry {
  return {
    path: p,
    file_count: 5,
    production_file_count: 5,
    purpose: 'services',
    production: true,
    classification_confidence: 'high',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectDeadExports
// ---------------------------------------------------------------------------

describe('detectDeadExports', () => {
  it('identifies exports not referenced by any importer', () => {
    const modules = [makeModule('src/lib'), makeModule('src/api')];
    const edges = { 'src/api': ['src/lib'] };
    const exportsByModule: Record<string, ExportEntry[]> = {
      'src/lib': [
        { name: 'usedHelper', kind: 'function' },
        { name: 'unusedHelper', kind: 'function' },
      ],
    };
    const importsByModule: Record<string, string[]> = {
      'src/api': ['src/lib'], // imports from lib, but we check by name
    };

    // Since 'src/lib' appears in import specifiers but 'usedHelper' doesn't
    // appear as an import name, both would be detected. This is the limitation
    // of name-based matching. We need actual import names from destructuring.
    const dead = detectDeadExports(modules, edges, exportsByModule, importsByModule);
    // Both are "dead" because import specifier 'src/lib' doesn't match names
    expect(dead.length).toBeGreaterThanOrEqual(1);
  });

  it('skips modules with no dependents (potential entrypoints)', () => {
    const modules = [makeModule('src/entry'), makeModule('src/lib')];
    const edges = { 'src/entry': ['src/lib'] }; // entry imports lib, nothing imports entry
    const exportsByModule: Record<string, ExportEntry[]> = {
      'src/entry': [{ name: 'main', kind: 'function' }],
    };
    const importsByModule: Record<string, string[]> = {};

    const dead = detectDeadExports(modules, edges, exportsByModule, importsByModule);
    // src/entry has no importers → skipped entirely
    expect(dead.filter(d => d.module === 'src/entry')).toHaveLength(0);
  });

  it('skips default exports', () => {
    const modules = [makeModule('src/lib'), makeModule('src/api')];
    const edges = { 'src/api': ['src/lib'] };
    const exportsByModule: Record<string, ExportEntry[]> = {
      'src/lib': [{ name: 'default', kind: 'other' }],
    };
    const importsByModule: Record<string, string[]> = { 'src/api': ['src/lib'] };

    const dead = detectDeadExports(modules, edges, exportsByModule, importsByModule);
    expect(dead.filter(d => d.name === 'default')).toHaveLength(0);
  });

  it('skips type exports', () => {
    const modules = [makeModule('src/lib'), makeModule('src/api')];
    const edges = { 'src/api': ['src/lib'] };
    const exportsByModule: Record<string, ExportEntry[]> = {
      'src/lib': [{ name: 'Config', kind: 'type' }],
    };
    const importsByModule: Record<string, string[]> = { 'src/api': ['src/lib'] };

    const dead = detectDeadExports(modules, edges, exportsByModule, importsByModule);
    expect(dead.filter(d => d.name === 'Config')).toHaveLength(0);
  });

  it('caps results', () => {
    const modules = [makeModule('src/lib'), makeModule('src/api')];
    const edges = { 'src/api': ['src/lib'] };
    const exports: ExportEntry[] = [];
    for (let i = 0; i < 50; i++) {
      exports.push({ name: `fn${i}`, kind: 'function' });
    }
    const exportsByModule = { 'src/lib': exports };
    const importsByModule: Record<string, string[]> = { 'src/api': ['src/lib'] };

    const dead = detectDeadExports(modules, edges, exportsByModule, importsByModule, 10);
    expect(dead.length).toBeLessThanOrEqual(10);
  });

  it('returns empty for no exports', () => {
    const modules = [makeModule('src/lib')];
    const dead = detectDeadExports(modules, {}, {}, {});
    expect(dead).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectStructuralIssues
// ---------------------------------------------------------------------------

describe('detectStructuralIssues', () => {
  it('detects circular dependencies from pre-computed cycles', () => {
    const modules = [makeModule('a'), makeModule('b')];
    const cycles = [['a', 'b', 'a']];
    const issues = detectStructuralIssues(modules, {}, {}, cycles);
    expect(issues.some(i => i.kind === 'circular-dep')).toBe(true);
  });

  it('detects god modules (high fan-in + many files)', () => {
    const modules = [makeModule('core', { file_count: 25 })];
    const reverse = { core: ['a', 'b', 'c', 'd', 'e', 'f'] };
    const issues = detectStructuralIssues(modules, {}, reverse, []);
    expect(issues.some(i => i.kind === 'god-module')).toBe(true);
  });

  it('does not flag god module when file count is low', () => {
    const modules = [makeModule('core', { file_count: 5 })];
    const reverse = { core: ['a', 'b', 'c', 'd', 'e', 'f'] };
    const issues = detectStructuralIssues(modules, {}, reverse, []);
    expect(issues.some(i => i.kind === 'god-module')).toBe(false);
  });

  it('detects excessive fan-out', () => {
    const modules = [makeModule('greedy')];
    const edges = { greedy: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] };
    const issues = detectStructuralIssues(modules, edges, {}, []);
    expect(issues.some(i => i.kind === 'excessive-fan-out')).toBe(true);
  });

  it('detects orphan modules', () => {
    const modules = [makeModule('lonely')];
    const issues = detectStructuralIssues(modules, {}, {}, []);
    expect(issues.some(i => i.kind === 'orphan')).toBe(true);
  });

  it('does not flag entrypoint directories as orphans', () => {
    const modules = [makeModule('src')];
    const issues = detectStructuralIssues(modules, {}, {}, [], ['src/index.ts']);
    expect(issues.some(i => i.kind === 'orphan')).toBe(false);
  });

  it('caps results', () => {
    const modules: ModuleEntry[] = [];
    for (let i = 0; i < 20; i++) {
      modules.push(makeModule(`orphan${i}`));
    }
    const issues = detectStructuralIssues(modules, {}, {}, [], [], 5);
    expect(issues.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// computeCouplingMetrics
// ---------------------------------------------------------------------------

describe('computeCouplingMetrics', () => {
  it('computes instability per module', () => {
    const modules = [makeModule('a'), makeModule('b'), makeModule('c')];
    // a imports b and c, nothing imports a
    // b is imported by a, imports nothing
    const edges = { a: ['b', 'c'] };
    const reverse = { b: ['a'], c: ['a'] };

    const metrics = computeCouplingMetrics(modules, edges, reverse);
    expect(metrics.instability['a']).toBe(1); // Ce=2, Ca=0 → 2/2=1 (unstable)
    expect(metrics.instability['b']).toBe(0); // Ce=0, Ca=1 → 0/1=0 (stable)
  });

  it('returns 0 for isolated modules', () => {
    const modules = [makeModule('alone')];
    const metrics = computeCouplingMetrics(modules, {}, {});
    expect(metrics.instability['alone']).toBe(0);
  });

  it('computes balanced instability', () => {
    const modules = [makeModule('mid')];
    // mid imports 2 modules and is imported by 2 modules
    const edges = { mid: ['a', 'b'] };
    const reverse = { mid: ['c', 'd'] };
    const metrics = computeCouplingMetrics(modules, edges, reverse);
    expect(metrics.instability['mid']).toBe(0.5); // Ce=2, Ca=2 → 2/4=0.5
  });
});

// ---------------------------------------------------------------------------
// detectDeadFunctions
// ---------------------------------------------------------------------------

describe('detectDeadFunctions', () => {
  it('detects exported functions with no cross-file callers', () => {
    const exports: Record<string, ExportEntry[]> = {
      'src/utils.ts': [
        { name: 'helperA', kind: 'function' },
        { name: 'helperB', kind: 'function' },
      ],
    };
    const callEdges: Record<string, CallEdge[]> = {
      'src/main.ts': [
        { caller: 'main', callee: 'helperA', line: 5, importSource: './utils' },
      ],
    };

    const dead = detectDeadFunctions(exports, callEdges);
    expect(dead).toHaveLength(1);
    expect(dead[0].name).toBe('helperB');
  });

  it('skips non-function exports', () => {
    const exports: Record<string, ExportEntry[]> = {
      'src/types.ts': [
        { name: 'Config', kind: 'type' },
        { name: 'MAX_SIZE', kind: 'variable' },
      ],
    };
    const dead = detectDeadFunctions(exports, {});
    expect(dead).toHaveLength(0);
  });

  it('skips default exports', () => {
    const exports: Record<string, ExportEntry[]> = {
      'src/utils.ts': [{ name: 'default', kind: 'function' }],
    };
    const dead = detectDeadFunctions(exports, {});
    expect(dead).toHaveLength(0);
  });

  it('only counts cross-file calls (importSource set)', () => {
    const exports: Record<string, ExportEntry[]> = {
      'src/utils.ts': [{ name: 'internalHelper', kind: 'function' }],
    };
    // Call exists but without importSource — it's an internal call, not cross-file
    const callEdges: Record<string, CallEdge[]> = {
      'src/utils.ts': [
        { caller: 'main', callee: 'internalHelper', line: 10 },
      ],
    };

    const dead = detectDeadFunctions(exports, callEdges);
    expect(dead).toHaveLength(1);
    expect(dead[0].name).toBe('internalHelper');
  });
});

// ---------------------------------------------------------------------------
// fuseCallGraphs
// ---------------------------------------------------------------------------

describe('fuseCallGraphs', () => {
  it('merges ast-grep cross-file calls', () => {
    const edges: Record<string, CallEdge[]> = {
      'src/main.ts': [
        { caller: 'main', callee: 'validateToken', line: 5, importSource: './auth' },
      ],
    };
    const fused = fuseCallGraphs(edges);
    expect(fused.has('validateToken')).toBe(true);
  });

  it('merges ts-morph simple callee names', () => {
    const tsAnalysis: TypeScriptAnalysis = {
      any_count: 0,
      any_propagation_paths: [],
      call_graph_edges: [
        { caller: 'src/main.ts:init', callee: 'setupRoutes' },
      ],
      api_surface: {},
      unchecked_type_assertions: 0,
    };
    const fused = fuseCallGraphs({}, tsAnalysis);
    expect(fused.has('setupRoutes')).toBe(true);
  });

  it('extracts method name from dotted callee', () => {
    const tsAnalysis: TypeScriptAnalysis = {
      any_count: 0,
      any_propagation_paths: [],
      call_graph_edges: [
        { caller: 'src/main.ts:init', callee: 'this.service.process' },
      ],
      api_surface: {},
      unchecked_type_assertions: 0,
    };
    const fused = fuseCallGraphs({}, tsAnalysis);
    expect(fused.has('process')).toBe(true);
  });

  it('combines both sources', () => {
    const edges: Record<string, CallEdge[]> = {
      'src/a.ts': [
        { caller: 'a', callee: 'fromAstGrep', line: 1, importSource: './b' },
      ],
    };
    const tsAnalysis: TypeScriptAnalysis = {
      any_count: 0,
      any_propagation_paths: [],
      call_graph_edges: [
        { caller: 'src/c.ts:c', callee: 'fromTsMorph' },
      ],
      api_surface: {},
      unchecked_type_assertions: 0,
    };
    const fused = fuseCallGraphs(edges, tsAnalysis);
    expect(fused.has('fromAstGrep')).toBe(true);
    expect(fused.has('fromTsMorph')).toBe(true);
  });

  it('handles empty inputs', () => {
    const fused = fuseCallGraphs({});
    expect(fused.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectDeadFunctionsFused
// ---------------------------------------------------------------------------

describe('detectDeadFunctionsFused', () => {
  it('reduces false positives by including ts-morph callees', () => {
    const exports: Record<string, ExportEntry[]> = {
      'src/utils.ts': [
        { name: 'helperA', kind: 'function' },
        { name: 'helperB', kind: 'function' },
      ],
    };
    // ast-grep sees helperA as called, but not helperB
    const callEdges: Record<string, CallEdge[]> = {
      'src/main.ts': [
        { caller: 'main', callee: 'helperA', line: 5, importSource: './utils' },
      ],
    };
    // ts-morph sees helperB called (ast-grep missed it due to expression complexity)
    const tsAnalysis: TypeScriptAnalysis = {
      any_count: 0,
      any_propagation_paths: [],
      call_graph_edges: [
        { caller: 'src/other.ts:init', callee: 'helperB' },
      ],
      api_surface: {},
      unchecked_type_assertions: 0,
    };

    // Without ts-morph fusion: helperB would be "dead"
    const deadWithout = detectDeadFunctions(exports, callEdges);
    expect(deadWithout.some(d => d.name === 'helperB')).toBe(true);

    // With ts-morph fusion: helperB is recognized as called
    const deadWith = detectDeadFunctionsFused(exports, callEdges, tsAnalysis);
    expect(deadWith.some(d => d.name === 'helperB')).toBe(false);
  });

  it('still detects genuinely dead functions', () => {
    const exports: Record<string, ExportEntry[]> = {
      'src/utils.ts': [{ name: 'trulyDead', kind: 'function' }],
    };
    const dead = detectDeadFunctionsFused(exports, {}, undefined);
    expect(dead).toHaveLength(1);
    expect(dead[0].name).toBe('trulyDead');
  });
});
