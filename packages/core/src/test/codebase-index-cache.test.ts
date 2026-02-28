/**
 * Regression tests for AST cache correctness and index refresh triggers.
 *
 * Covers:
 * - ast-cache.ts (load/save/current-entry behavior)
 * - buildCodebaseIndex AST cache hit/miss behavior across runs
 * - hasStructuralChanges and getTrackedDirectories fallback paths
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAstCache, saveAstCache, isEntryCurrent } from '../codebase-index/ast-cache.js';
import {
  buildCodebaseIndex,
  getTrackedDirectories,
  hasStructuralChanges,
} from '../codebase-index/index.js';
import type { AstGrepModule } from '../codebase-index/ast-analysis.js';
import type { CodebaseIndex } from '../codebase-index/shared.js';

interface MockAstNode {
  kind(): string;
  text(): string;
  children(): MockAstNode[];
  findAll(rule: { rule: { kind: string } }): MockAstNode[];
  isNamed(): boolean;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function findModule(index: CodebaseIndex, modulePath: string) {
  return index.modules.find(m => m.path === modulePath);
}

function createMockNode(kind: string, text: string, children: MockAstNode[] = []): MockAstNode {
  return {
    kind: () => kind,
    text: () => text,
    children: () => children,
    findAll: (rule: { rule: { kind: string } }) => {
      const matches: MockAstNode[] = [];
      const stack = [...children];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.kind() === rule.rule.kind) {
          matches.push(node);
        }
        stack.push(...node.children());
      }
      return matches;
    },
    isNamed: () => true,
  };
}

function createCountingAstGrep(): { astGrep: AstGrepModule; getParseCount: () => number } {
  let parseCount = 0;

  const astGrep: AstGrepModule = {
    parse: (_lang, source) => {
      parseCount++;
      const children: MockAstNode[] = [];

      for (const match of source.matchAll(/^\s*import[^\n]+/gm)) {
        children.push(createMockNode('import_statement', match[0].trim()));
      }
      for (const match of source.matchAll(/^\s*export[^\n]+/gm)) {
        children.push(createMockNode('export_statement', match[0].trim()));
      }
      const ifMatches = source.match(/\bif\s*\(/g) ?? [];
      for (let i = 0; i < ifMatches.length; i++) {
        children.push(createMockNode('if_statement', 'if (...) {}'));
      }

      return { root: () => createMockNode('program', source, children) };
    },
    Lang: {
      TypeScript: 'TypeScript',
      Tsx: 'Tsx',
      JavaScript: 'JavaScript',
      Python: 'Python',
      Go: 'Go',
      Rust: 'Rust',
      Java: 'Java',
      Ruby: 'Ruby',
    },
  };

  return { astGrep, getParseCount: () => parseCount };
}

describe('ast-cache I/O', () => {
  it('returns empty cache when the cache file is missing', () => {
    const projectRoot = makeTempDir('ast-cache-missing-');
    expect(loadAstCache(projectRoot)).toEqual({});
  });

  it('returns empty cache when the cache file is corrupt', () => {
    const projectRoot = makeTempDir('ast-cache-corrupt-');
    writeFile(path.join(projectRoot, '.promptwheel', 'ast-cache.json'), '{not-valid-json');
    expect(loadAstCache(projectRoot)).toEqual({});
  });

  it('prunes stale entries when saving with current file set', () => {
    const projectRoot = makeTempDir('ast-cache-prune-');
    const cache = {
      'src/current.ts': {
        mtime: 100,
        size: 10,
        imports: ['./x'],
        exports: [{ name: 'currentFn', kind: 'function' as const }],
        complexity: 2,
      },
      'src/stale.ts': {
        mtime: 200,
        size: 20,
        imports: ['./y'],
        exports: [{ name: 'staleFn', kind: 'function' as const }],
        complexity: 3,
      },
    };

    saveAstCache(projectRoot, cache, new Set(['src/current.ts']));
    const loaded = loadAstCache(projectRoot);

    expect(Object.keys(loaded)).toEqual(['src/current.ts']);
    expect(loaded['src/current.ts'].exports[0]?.name).toBe('currentFn');
    expect(loaded['src/stale.ts']).toBeUndefined();
  });

  it('matches entries only when mtime and size are unchanged', () => {
    const entry = {
      mtime: 1234,
      size: 64,
      imports: [],
      exports: [],
      complexity: 1,
    };

    expect(isEntryCurrent(entry, 1234, 64)).toBe(true);
    expect(isEntryCurrent(entry, 1235, 64)).toBe(false);
    expect(isEntryCurrent(entry, 1234, 65)).toBe(false);
    expect(isEntryCurrent(undefined, 1234, 64)).toBe(false);
  });
});

describe('buildCodebaseIndex AST cache regression', () => {
  it('reuses cache across runs and invalidates changed files only', () => {
    const projectRoot = makeTempDir('codebase-index-ast-cache-');
    const fileA = path.join(projectRoot, 'src', 'lib', 'alpha.ts');
    const fileB = path.join(projectRoot, 'src', 'lib', 'beta.ts');

    writeFile(fileA, 'export function alpha() { if (ok) return 1; return 0; }\n');
    writeFile(fileB, 'export function beta() { if (ok) return 2; return 0; }\n');

    const { astGrep, getParseCount } = createCountingAstGrep();

    const first = buildCodebaseIndex(projectRoot, [], false, astGrep);
    const firstModule = findModule(first, 'src/lib');
    expect(first.analysis_backend).toBe('ast-grep');
    // 2 files × 3 parses each (analyzeFileAst + extractTopLevelSymbols + extractCallEdges)
    expect(getParseCount()).toBe(6);
    expect(firstModule?.export_count).toBe(2);
    expect(firstModule?.avg_complexity).toBe(2);

    const second = buildCodebaseIndex(projectRoot, [], false, astGrep);
    const secondModule = findModule(second, 'src/lib');
    // Full cache hit — no additional parses (symbols + callEdges already cached)
    expect(getParseCount()).toBe(6);
    expect(secondModule?.export_count).toBe(firstModule?.export_count);
    expect(secondModule?.avg_complexity).toBe(firstModule?.avg_complexity);

    writeFile(
      fileB,
      'export function beta() { if (ok) return 2; if (again) return 3; return 0; }\n' +
      'export function betaHelper() { return 1; }\n',
    );

    const third = buildCodebaseIndex(projectRoot, [], false, astGrep);
    const thirdModule = findModule(third, 'src/lib');
    // Only fileB re-parsed (3 parses: analyzeFileAst + extractTopLevelSymbols + extractCallEdges)
    expect(getParseCount()).toBe(9);
    expect(thirdModule?.export_count).toBe(3);
    expect((thirdModule?.avg_complexity ?? 0) > (secondModule?.avg_complexity ?? 0)).toBe(true);
  });
});

describe('refresh helpers regression', () => {
  it('detects sampled-file mtime changes as structural changes', () => {
    const projectRoot = makeTempDir('structural-change-modified-');
    const filePath = path.join(projectRoot, 'src', 'services', 'index.ts');
    writeFile(filePath, 'export function run() { return 1; }\n');

    const index = buildCodebaseIndex(projectRoot, [], false);
    expect(hasStructuralChanges(index, projectRoot)).toBe(false);

    writeFile(filePath, 'export function run() { return 2; }\n');

    expect(hasStructuralChanges(index, projectRoot)).toBe(true);
  });

  it('detects deleted sampled files as structural changes', () => {
    const projectRoot = makeTempDir('structural-change-deleted-');
    const filePath = path.join(projectRoot, 'src', 'utils', 'helper.ts');
    writeFile(filePath, 'export const helper = 1;\n');

    const index = buildCodebaseIndex(projectRoot, [], false);
    expect(hasStructuralChanges(index, projectRoot)).toBe(false);

    fs.unlinkSync(filePath);

    expect(hasStructuralChanges(index, projectRoot)).toBe(true);
  });

  it('returns null tracked dirs on non-git roots and still indexes with git tracking enabled', () => {
    const projectRoot = makeTempDir('tracked-dirs-fallback-');
    writeFile(path.join(projectRoot, 'src', 'main.ts'), 'export const main = true;\n');

    expect(getTrackedDirectories(projectRoot)).toBeNull();

    const index = buildCodebaseIndex(projectRoot, [], true);
    expect(index.modules.some(m => m.path === 'src')).toBe(true);
  });
});
