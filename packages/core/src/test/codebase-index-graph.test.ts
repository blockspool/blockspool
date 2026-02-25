/**
 * Graph intelligence tests — covers dependency graph analysis functions
 * in codebase-index/shared.ts:
 *   - computeReverseEdges
 *   - detectCycles
 *   - computeGraphMetrics
 *   - formatIndexForPrompt (graph insights section)
 */

import { describe, it, expect } from 'vitest';
import {
  computeReverseEdges,
  detectCycles,
  computeGraphMetrics,
  formatIndexForPrompt,
  type CodebaseIndex,
  type ModuleEntry,
} from '../codebase-index/shared.js';

// ---------------------------------------------------------------------------
// computeReverseEdges
// ---------------------------------------------------------------------------

describe('computeReverseEdges', () => {
  it('inverts a simple edge map', () => {
    const edges = {
      'src/api': ['src/lib', 'src/utils'],
      'src/lib': ['src/utils'],
    };
    const reverse = computeReverseEdges(edges);
    expect(reverse).toEqual({
      'src/lib': ['src/api'],
      'src/utils': ['src/api', 'src/lib'],
    });
  });

  it('returns empty object for empty input', () => {
    expect(computeReverseEdges({})).toEqual({});
  });

  it('handles multiple sources importing the same target', () => {
    const edges = {
      a: ['shared'],
      b: ['shared'],
      c: ['shared'],
    };
    const reverse = computeReverseEdges(edges);
    expect(reverse['shared']).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------

describe('detectCycles', () => {
  it('returns empty array when no cycles exist', () => {
    const edges = {
      a: ['b'],
      b: ['c'],
    };
    expect(detectCycles(edges)).toEqual([]);
  });

  it('detects a simple two-node cycle', () => {
    const edges = {
      a: ['b'],
      b: ['a'],
    };
    const cycles = detectCycles(edges);
    expect(cycles.length).toBe(1);
    // Cycle should contain both nodes and loop back
    expect(cycles[0]).toContain('a');
    expect(cycles[0]).toContain('b');
    expect(cycles[0][0]).toBe(cycles[0][cycles[0].length - 1]);
  });

  it('detects a three-node cycle', () => {
    const edges = {
      a: ['b'],
      b: ['c'],
      c: ['a'],
    };
    const cycles = detectCycles(edges);
    expect(cycles.length).toBe(1);
    expect(cycles[0].length).toBe(4); // a → b → c → a
  });

  it('detects self-loop', () => {
    const edges = {
      a: ['a'],
    };
    const cycles = detectCycles(edges);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(['a', 'a']);
  });

  it('detects multiple independent cycles', () => {
    const edges = {
      a: ['b'],
      b: ['a'],
      c: ['d'],
      d: ['c'],
    };
    const cycles = detectCycles(edges);
    expect(cycles.length).toBe(2);
  });

  it('caps cycles at 10', () => {
    // Build 15 independent 2-node cycles
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < 15; i++) {
      const a = `a${i}`;
      const b = `b${i}`;
      edges[a] = [b];
      edges[b] = [a];
    }
    const cycles = detectCycles(edges);
    expect(cycles.length).toBe(10);
  });

  it('returns empty for empty graph', () => {
    expect(detectCycles({})).toEqual([]);
  });

  it('handles edges to nodes not in edge keys (leaf targets)', () => {
    const edges = {
      a: ['b'],
      b: ['c'],
      // c has no outgoing edges
    };
    expect(detectCycles(edges)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeGraphMetrics
// ---------------------------------------------------------------------------

function makeModule(p: string): ModuleEntry {
  return {
    path: p,
    file_count: 5,
    production_file_count: 5,
    purpose: 'services',
    production: true,
    classification_confidence: 'high',
  };
}

describe('computeGraphMetrics', () => {
  it('classifies hub modules (fan_in >= 3)', () => {
    const modules = [makeModule('core'), makeModule('a'), makeModule('b'), makeModule('c')];
    const edges = { a: ['core'], b: ['core'], c: ['core'] };
    const reverse = computeReverseEdges(edges);
    const metrics = computeGraphMetrics(modules, edges, reverse);
    expect(metrics.hub_modules).toEqual(['core']);
  });

  it('classifies leaf modules (fan_out > 0, fan_in = 0)', () => {
    const modules = [makeModule('leaf'), makeModule('core')];
    const edges = { leaf: ['core'] };
    const reverse = computeReverseEdges(edges);
    const metrics = computeGraphMetrics(modules, edges, reverse);
    expect(metrics.leaf_modules).toEqual(['leaf']);
  });

  it('classifies orphan modules (no edges at all)', () => {
    const modules = [makeModule('isolated'), makeModule('connected')];
    const edges = { connected: ['isolated'] }; // connected imports isolated
    const reverse = computeReverseEdges(edges);
    const metrics = computeGraphMetrics(modules, edges, reverse);
    // 'isolated' has fan_in=1 (imported by connected), fan_out=0 → not orphan, not leaf
    // 'connected' has fan_in=0, fan_out=1 → leaf
    expect(metrics.orphan_modules).toEqual([]);
    expect(metrics.leaf_modules).toEqual(['connected']);
  });

  it('identifies true orphans with no connections', () => {
    const modules = [makeModule('alone'), makeModule('also-alone')];
    const edges: Record<string, string[]> = {};
    const reverse = computeReverseEdges(edges);
    const metrics = computeGraphMetrics(modules, edges, reverse);
    expect(metrics.orphan_modules).toEqual(['alone', 'also-alone']);
    expect(metrics.hub_modules).toEqual([]);
    expect(metrics.leaf_modules).toEqual([]);
  });

  it('handles empty module list', () => {
    const metrics = computeGraphMetrics([], {}, {});
    expect(metrics.hub_modules).toEqual([]);
    expect(metrics.orphan_modules).toEqual([]);
    expect(metrics.leaf_modules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatIndexForPrompt — graph insights section
// ---------------------------------------------------------------------------

describe('formatIndexForPrompt graph insights', () => {
  function makeIndex(overrides: Partial<CodebaseIndex> = {}): CodebaseIndex {
    return {
      built_at: new Date().toISOString(),
      modules: [makeModule('src/api'), makeModule('src/lib')],
      dependency_edges: {},
      reverse_edges: {},
      dependency_cycles: [],
      untested_modules: [],
      large_files: [],
      entrypoints: [],
      sampled_file_mtimes: {},
      ...overrides,
    };
  }

  it('includes hub modules in graph insights', () => {
    const index = makeIndex({
      graph_metrics: {
        hub_modules: ['src/utils', 'src/core'],
        orphan_modules: [],
        leaf_modules: [],
      },
    });
    const output = formatIndexForPrompt(index, 0);
    expect(output).toContain('### Dependency Graph Insights');
    expect(output).toContain('Hub modules (3+ dependents): src/utils, src/core');
  });

  it('includes circular dependencies in graph insights', () => {
    const index = makeIndex({
      dependency_cycles: [['src/a', 'src/b', 'src/a']],
    });
    const output = formatIndexForPrompt(index, 0);
    expect(output).toContain('Circular dependencies: src/a → src/b → src/a');
  });

  it('omits graph insights section when no data', () => {
    const index = makeIndex();
    const output = formatIndexForPrompt(index, 0);
    expect(output).not.toContain('### Dependency Graph Insights');
  });

  it('includes orphan modules in graph insights', () => {
    const index = makeIndex({
      graph_metrics: {
        hub_modules: [],
        orphan_modules: ['src/abandoned'],
        leaf_modules: [],
      },
    });
    const output = formatIndexForPrompt(index, 0);
    expect(output).toContain('Orphan modules (no dependencies): src/abandoned');
  });
});
