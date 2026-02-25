/**
 * Tests for formatAnalysisForPrompt — analysis block rendering and cycle rotation.
 */

import { describe, it, expect } from 'vitest';
import { formatAnalysisForPrompt } from '../codebase-index/format-analysis.js';
import type { CodebaseIndex, ModuleEntry } from '../codebase-index/shared.js';

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

function makeIndex(overrides: Partial<CodebaseIndex> = {}): CodebaseIndex {
  return {
    built_at: new Date().toISOString(),
    modules: [makeModule('src/lib'), makeModule('src/api')],
    dependency_edges: { 'src/api': ['src/lib'] },
    untested_modules: [],
    large_files: [],
    entrypoints: [],
    sampled_file_mtimes: {},
    ...overrides,
  };
}

describe('formatAnalysisForPrompt', () => {
  it('returns null when no analysis data exists', () => {
    const index = makeIndex({
      modules: [],
      dependency_edges: {},
    });
    expect(formatAnalysisForPrompt(index, 0)).toBeNull();
  });

  it('includes dead exports section', () => {
    const index = makeIndex({
      dead_exports: [
        { module: 'src/lib', name: 'unusedHelper', kind: 'function' },
        { module: 'src/lib', name: 'oldFn', kind: 'function' },
        { module: 'src/api', name: 'legacyRoute', kind: 'function' },
      ],
    });
    const result = formatAnalysisForPrompt(index, 0);
    expect(result).toContain('## Codebase Analysis');
    expect(result).toContain('Dead Exports (3 potentially unused)');
    expect(result).toContain('unusedHelper');
    expect(result).toContain('legacyRoute');
  });

  it('includes structural issues section', () => {
    const index = makeIndex({
      structural_issues: [
        { kind: 'god-module', module: 'src/core', detail: 'fan-in: 12, 48 files', severity: 'warning' },
        { kind: 'orphan', module: 'src/legacy', detail: 'no dependencies', severity: 'info' },
      ],
    });
    const result = formatAnalysisForPrompt(index, 0);
    expect(result).toContain('Structural Issues');
    expect(result).toContain('god-module');
    expect(result).toContain('orphan');
  });

  it('includes graph topology section', () => {
    const index = makeIndex({
      graph_metrics: {
        hub_modules: ['src/core', 'src/utils'],
        orphan_modules: ['src/legacy'],
        leaf_modules: ['src/api'],
      },
      dependency_cycles: [['src/a', 'src/b', 'src/a']],
    });
    const result = formatAnalysisForPrompt(index, 0);
    expect(result).toContain('Graph Topology');
    expect(result).toContain('Hub modules');
    expect(result).toContain('Circular dependencies');
  });

  it('includes coupling analysis section', () => {
    const index = makeIndex({
      modules: [
        makeModule('src/leaf', { production: true }),
        makeModule('src/hub', { production: true }),
      ],
      dependency_edges: { 'src/leaf': ['src/hub', 'src/other'] },
      reverse_edges: { 'src/hub': ['src/leaf', 'src/api', 'src/services'] },
    });
    const result = formatAnalysisForPrompt(index, 0);
    expect(result).toContain('Coupling Analysis');
  });

  it('shows all sections when 3 or fewer are available', () => {
    const index = makeIndex({
      dead_exports: [{ module: 'src/lib', name: 'unused', kind: 'function' }],
      structural_issues: [{ kind: 'orphan', module: 'src/x', detail: 'no deps', severity: 'info' }],
      graph_metrics: { hub_modules: ['src/core'], orphan_modules: [], leaf_modules: [] },
    });
    const result = formatAnalysisForPrompt(index, 0)!;
    expect(result).toContain('Dead Exports');
    expect(result).toContain('Structural Issues');
    expect(result).toContain('Graph Topology');
  });

  it('rotates sections across cycles when all 4 are present', () => {
    const index = makeIndex({
      dead_exports: [{ module: 'src/lib', name: 'unused', kind: 'function' }],
      structural_issues: [{ kind: 'orphan', module: 'src/x', detail: 'no deps', severity: 'info' }],
      graph_metrics: { hub_modules: ['src/core'], orphan_modules: [], leaf_modules: [] },
      modules: [
        makeModule('src/leaf', { production: true }),
        makeModule('src/hub', { production: true }),
      ],
      dependency_edges: { 'src/leaf': ['src/hub', 'src/other'] },
      reverse_edges: { 'src/hub': ['src/leaf', 'src/api', 'src/services'] },
    });

    // With 4 sections and window size 3, different cycles should show different sets
    const cycle0 = formatAnalysisForPrompt(index, 0)!;
    const cycle1 = formatAnalysisForPrompt(index, 1)!;

    // Both cycles should have the header
    expect(cycle0).toContain('## Codebase Analysis');
    expect(cycle1).toContain('## Codebase Analysis');

    // At least one section should differ between cycles (rotation in effect)
    // Cycle 0: sections 0,1,2 (dead-exports, structural, graph)
    // Cycle 1: sections 3,0,1 (coupling, dead-exports, structural)
    expect(cycle0).not.toEqual(cycle1);
  });

  it('groups dead exports by module', () => {
    const index = makeIndex({
      dead_exports: [
        { module: 'src/utils', name: 'fnA', kind: 'function' },
        { module: 'src/utils', name: 'fnB', kind: 'function' },
        { module: 'src/lib', name: 'fnC', kind: 'function' },
      ],
    });
    const result = formatAnalysisForPrompt(index, 0)!;
    expect(result).toContain('src/utils: fnA, fnB');
    expect(result).toContain('src/lib: fnC');
  });
});
