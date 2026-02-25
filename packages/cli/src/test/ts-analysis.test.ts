/**
 * Tests for TypeScript deep analysis and cache.
 * Uses mocks since ts-morph is an optional dependency.
 */

import { describe, it, expect } from 'vitest';
import {
  loadTsAnalysisCache,
  saveTsAnalysisCache,
} from '../lib/ts-analysis-cache.js';
import type { TypeScriptAnalysis } from '@promptwheel/core/codebase-index';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Cache tests (no ts-morph needed)
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ts-test-'));
}

function makeAnalysis(overrides: Partial<TypeScriptAnalysis> = {}): TypeScriptAnalysis {
  return {
    any_count: 5,
    any_propagation_paths: [],
    call_graph_edges: [],
    api_surface: { 'src/lib': 3 },
    unchecked_type_assertions: 2,
    ...overrides,
  };
}

describe('ts-analysis-cache', () => {
  it('returns null for missing cache', () => {
    const tmpDir = makeTmpDir();
    expect(loadTsAnalysisCache(tmpDir)).toBeNull();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('round-trips analysis through cache', () => {
    const tmpDir = makeTmpDir();
    // Create a fake tsconfig.json
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');

    const analysis = makeAnalysis({ any_count: 42 });
    saveTsAnalysisCache(tmpDir, analysis, 10);

    const loaded = loadTsAnalysisCache(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.any_count).toBe(42);
    expect(loaded!.unchecked_type_assertions).toBe(2);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('invalidates cache when tsconfig changes', () => {
    const tmpDir = makeTmpDir();
    const tsconfigPath = path.join(tmpDir, 'tsconfig.json');
    fs.writeFileSync(tsconfigPath, '{}');

    const analysis = makeAnalysis();
    saveTsAnalysisCache(tmpDir, analysis, 10);

    // Verify cache is valid
    expect(loadTsAnalysisCache(tmpDir)).not.toBeNull();

    // Touch tsconfig to change mtime
    const now = new Date();
    fs.utimesSync(tsconfigPath, now, new Date(now.getTime() + 1000));

    // Cache should now be stale
    expect(loadTsAnalysisCache(tmpDir)).toBeNull();

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns null when tsconfig is missing', () => {
    const tmpDir = makeTmpDir();
    // Write cache but no tsconfig
    const cachePath = path.join(tmpDir, '.promptwheel', 'ts-analysis-cache.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      tsconfigMtime: 12345,
      sourceFileCount: 5,
      analysis: makeAnalysis(),
      cachedAt: new Date().toISOString(),
    }));

    expect(loadTsAnalysisCache(tmpDir)).toBeNull();

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('handles corrupt cache gracefully', () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    const cachePath = path.join(tmpDir, '.promptwheel', 'ts-analysis-cache.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, 'not valid json{{{');

    expect(loadTsAnalysisCache(tmpDir)).toBeNull();

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Format analysis integration with TS data
// ---------------------------------------------------------------------------

describe('formatAnalysisForPrompt with TypeScript data', () => {
  it('includes TypeScript section when analysis is available', async () => {
    const { formatAnalysisForPrompt } = await import('@promptwheel/core/codebase-index');

    const result = formatAnalysisForPrompt({
      built_at: new Date().toISOString(),
      modules: [],
      dependency_edges: {},
      untested_modules: [],
      large_files: [],
      entrypoints: [],
      sampled_file_mtimes: {},
      typescript_analysis: makeAnalysis({ any_count: 42, unchecked_type_assertions: 10 }),
    }, 0);

    expect(result).toContain('TypeScript Quality');
    expect(result).toContain('any-count: 42');
    expect(result).toContain('type assertions: 10');
  });

  it('skips TypeScript section when counts are zero', async () => {
    const { formatAnalysisForPrompt } = await import('@promptwheel/core/codebase-index');

    const result = formatAnalysisForPrompt({
      built_at: new Date().toISOString(),
      modules: [],
      dependency_edges: {},
      untested_modules: [],
      large_files: [],
      entrypoints: [],
      sampled_file_mtimes: {},
      typescript_analysis: makeAnalysis({ any_count: 0, unchecked_type_assertions: 0 }),
    }, 0);

    // Should be null because no other analysis data and TS counts are zero
    expect(result).toBeNull();
  });

  it('includes API surface in TypeScript section', async () => {
    const { formatAnalysisForPrompt } = await import('@promptwheel/core/codebase-index');

    const result = formatAnalysisForPrompt({
      built_at: new Date().toISOString(),
      modules: [],
      dependency_edges: {},
      untested_modules: [],
      large_files: [],
      entrypoints: [],
      sampled_file_mtimes: {},
      typescript_analysis: makeAnalysis({
        any_count: 3,
        api_surface: { 'src/core': 25, 'src/utils': 15, 'src/api': 10 },
      }),
    }, 0);

    expect(result).toContain('Largest API surfaces');
    expect(result).toContain('src/core (25)');
  });
});
