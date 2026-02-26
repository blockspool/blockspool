/**
 * Codebase index shared algorithms — pure functions for module classification,
 * import extraction, dependency resolution, and prompt formatting.
 *
 * No filesystem, git, or child_process I/O. The I/O-heavy functions
 * (buildCodebaseIndex, refreshCodebaseIndex, hasStructuralChanges) live
 * in ./index.ts and import these pure algorithms.
 */

import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodebaseIndex {
  built_at: string;
  modules: ModuleEntry[];
  dependency_edges: Record<string, string[]>; // module → modules it imports from
  /** Reverse dependency map: module → modules that import it. Populated by graph analysis. */
  reverse_edges?: Record<string, string[]>;
  /** Detected circular dependency chains. Each array is a cycle path. Populated by graph analysis. */
  dependency_cycles?: string[][];
  /** Aggregate graph topology metrics. Populated by graph analysis. */
  graph_metrics?: GraphMetrics;
  untested_modules: string[];
  large_files: LargeFileEntry[];              // >300 LOC
  entrypoints: string[];
  /** mtimes of files sampled for import scanning — used for change detection. Not included in prompt. */
  sampled_file_mtimes: Record<string, number>;
  /** Which analysis backend was used: 'regex' (default) or 'ast-grep' (when available). */
  analysis_backend?: 'regex' | 'ast-grep';
  /** Potentially unused exports detected by cross-module matching. AST-only. */
  dead_exports?: DeadExportEntry[];
  /** Structural anti-patterns detected in the dependency graph. */
  structural_issues?: StructuralIssue[];
  /** TypeScript-specific semantic analysis results. ts-morph only. */
  typescript_analysis?: TypeScriptAnalysis;
  /** AST pattern scan findings — mechanically detected code issues. */
  ast_findings?: AstFindingEntry[];
}

export interface GraphMetrics {
  /** Modules with 3+ dependents (high fan-in). */
  hub_modules: string[];
  /** Modules with zero incoming or outgoing edges. */
  orphan_modules: string[];
  /** Modules that only import (no dependents). */
  leaf_modules: string[];
}

export type ClassificationConfidence = 'high' | 'medium' | 'low';

export interface ModuleEntry {
  path: string;       // "src/services"
  file_count: number;
  production_file_count: number; // excludes test/story/fixture files within mixed modules
  purpose: string;    // "api"|"services"|"tests"|"ui"|"utils"|"config"|"fixtures"|"docs"|"scripts"|"generated"|"unknown"
  production: boolean; // false for tests, config, fixtures, docs, scripts, generated, etc.
  /** How confident the classifier is. 'low' means no signals matched — assumed production. */
  classification_confidence: ClassificationConfidence;
  /** Number of modules that import this module. */
  fan_in?: number;
  /** Number of modules this module imports. */
  fan_out?: number;
  /** Total number of exported symbols across all files in this module. AST-only. */
  export_count?: number;
  /** Up to 20 exported symbol names (for cross-module matching). AST-only. */
  exported_names?: string[];
  /** Average cyclomatic complexity across files in this module. AST-only. */
  avg_complexity?: number;
}

// ---------------------------------------------------------------------------
// AST analysis types
// ---------------------------------------------------------------------------

export interface ExportEntry {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | 'other';
}

export interface AstAnalysisResult {
  imports: string[];
  exports: ExportEntry[];
  complexity: number;
  findings?: AstFinding[];
}

export interface AstFinding {
  patternId: string;
  message: string;
  line: number | null;
  severity: 'high' | 'medium' | 'low';
  category: 'fix' | 'refactor' | 'types' | 'security' | 'perf' | 'cleanup';
}

export interface AstFindingEntry {
  file: string;
  patternId: string;
  message: string;
  line: number | null;
  severity: 'high' | 'medium' | 'low';
  category: string;
}

export interface DeadExportEntry {
  module: string;
  name: string;
  kind: string;
}

export interface StructuralIssue {
  kind: 'circular-dep' | 'god-module' | 'excessive-fan-out' | 'barrel-only' | 'orphan';
  module: string;
  detail: string;
  severity: 'info' | 'warning';
}

export interface TypeScriptAnalysis {
  /** Total count of `any` type annotations across analyzed files. */
  any_count: number;
  /** Top propagation paths where `any` types spread through the codebase. Max 10. */
  any_propagation_paths: Array<{ source: string; reaches: string[]; length: number }>;
  /** Function-level call edges from analyzed files. Max 100. */
  call_graph_edges: Array<{ caller: string; callee: string }>;
  /** Public export count per module (module path → count). */
  api_surface: Record<string, number>;
  /** Count of unchecked type assertions (`as X`, non-null `!`). */
  unchecked_type_assertions: number;
}

export interface LargeFileEntry {
  path: string;
  lines: number;
}

export interface ClassifyResult {
  purpose: string;
  production: boolean;
  productionFileCount: number;
  confidence: ClassificationConfidence;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py',
  '.rs',
  '.go',
  '.rb',
  '.java', '.kt', '.kts', '.scala',
  '.cs',
  '.ex', '.exs',
  '.php',
  '.swift',
  '.dart',
  '.c', '.cpp', '.h', '.hpp',
  '.hs',
  '.lua',
  '.zig',
]);

/** Directory-name hint — fast path when the name is unambiguous. */
export const PURPOSE_HINT: Record<string, string> = {
  api: 'api', apis: 'api', routes: 'api', handlers: 'api',
  controllers: 'api', endpoints: 'api',
  services: 'services', service: 'services', lib: 'services', core: 'services',
  ui: 'ui', components: 'ui', views: 'ui', pages: 'ui', screens: 'ui',
  utils: 'utils', util: 'utils', helpers: 'utils', shared: 'utils', common: 'utils',
};

export const NON_PRODUCTION_PURPOSES = new Set([
  'tests', 'config', 'fixtures', 'docs', 'scripts', 'generated',
]);

/** Chunk size for prompt rendering. */
export const CHUNK_SIZE = 15;

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/** File-name patterns that indicate non-production files (even within production modules). */
export const NON_PROD_FILE_RE = /\.(test|spec|e2e|integration|stories|story)\./i;

/**
 * Polyglot non-production file-name patterns beyond the dot-delimited convention.
 * Covers Go (_test.go), Python (test_*.py, conftest.py), Ruby (_spec.rb),
 * Java/Kotlin (*Test.java), C# (*Tests.cs), Elixir (_test.exs), PHP (*Test.php),
 * Swift (*Tests.swift).
 */
const LANG_TEST_FILE_RE = /(?:_test\.go|_test\.exs?|_spec\.rb|(?:^|[/\\])test_[^/\\]+\.py|(?:^|[/\\])conftest\.py|Test(?:s)?\.(?:java|kt|kts|scala|cs|php|swift))$/;

/** Directory segments that indicate non-production context. */
const TEST_DIR_RE = /(?:^|[/\\])(?:__tests__|__fixtures__|__mocks__|testdata|test_helpers|fixtures|tests?|specs?)(?:[/\\]|$)/;

/**
 * Check whether a file path looks like a non-production file (test, spec, fixture, story, etc.).
 * Combines the dot-delimited convention (.test., .spec.) with language-specific naming patterns
 * and directory-based detection.
 */
export function isNonProductionFile(filePath: string): boolean {
  return NON_PROD_FILE_RE.test(filePath) || LANG_TEST_FILE_RE.test(filePath) || TEST_DIR_RE.test(filePath);
}

/**
 * Polyglot test-content patterns — matches test framework calls across languages.
 */
export const TEST_CONTENT_RE = new RegExp([
  /\b(describe|it|test|expect|assert|beforeEach|afterEach|beforeAll|afterAll|jest|vitest|mocha|chai)\s*[.(]/.source,
  /\b(pytest|unittest|def test_)\b/.source,
  /#\[(test|cfg\(test\))\]/.source,
  /\bfunc\s+Test[A-Z]/.source,
  /@(Test|TestMethod)\b/.source,
  /\b(RSpec\.|Minitest|should\s)/.source,
  /\b(ExUnit|use ExUnit)/.source,
  /\b(PHPUnit|->assert[A-Z])/.source,
  /\b(XCTestCase|func\s+test[A-Z])/.source,
].join('|'));

export const GENERATED_RE = /(@generated|DO NOT EDIT|auto-generated|THIS FILE IS GENERATED|generated by)/i;
export const CONFIG_CONTENT_RE = /\b(module\.exports|export default|defineConfig|createConfig)\b/;
export const CONFIG_EXT_RE = /\.(json|ya?ml|toml|ini|env)$/i;
export const FIXTURE_CONTENT_RE = /\b(mock[A-Z]\w*|fake[A-Z]\w*|stub[A-Z]\w*|fixture[A-Z]\w*)\s*[=:]|\bexport\s+(const|function)\s+(mock|fake|stub|fixture|seed|sample)/i;

// JS/TS: import ... from '...' or require('...')
export const JS_IMPORT_RE = /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
// Python: from X import ... or import X
export const PY_IMPORT_RE = /(?:from\s+([\w.]+)\s+import|^import\s+([\w.]+))/gm;
// Go: import "..."
export const GO_IMPORT_RE = /import\s+"([^"]+)"/g;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/** Map directory name to a purpose hint. Returns 'unknown' if no match. */
export function purposeHintFromDirName(dirName: string): string {
  return PURPOSE_HINT[dirName.toLowerCase()] ?? 'unknown';
}

/**
 * Pick up to `count` items, evenly spaced across the array.
 * Avoids alphabetical bias of always sampling the first N.
 */
export function sampleEvenly<T>(arr: T[], count: number): T[] {
  if (arr.length <= count) return arr;
  const step = arr.length / count;
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    result.push(arr[Math.floor(i * step)]);
  }
  return result;
}

/** Count non-production files by name pattern within a file list. */
export function countNonProdFiles(fileNames: string[]): number {
  return fileNames.filter(f => NON_PROD_FILE_RE.test(f)).length;
}

/**
 * Classify a module by analyzing its file names and content snippets.
 *
 * Uses file-name patterns (checked against ALL files — cheap string matching)
 * and content analysis (sampled snippets from evenly-distributed files).
 *
 * Thresholds use both ratio AND absolute count to avoid misclassifying
 * large mixed modules (40% test in a 500-file module ≠ production).
 */
export function classifyModule(
  dirName: string,
  allFileNames: string[],
  contentSnippets: string[],
  totalFileCount: number,
): ClassifyResult {
  const nonProdFiles = countNonProdFiles(allFileNames);
  const nonProdRatio = allFileNames.length > 0 ? nonProdFiles / allFileNames.length : 0;

  // 1. Majority of files are test/story files → whole module is non-production
  if (nonProdRatio > 0.5 || (nonProdFiles >= 10 && nonProdRatio > 0.4)) {
    return { purpose: 'tests', production: false, productionFileCount: 0, confidence: 'high' };
  }

  // 2. Check content signals across sampled snippets
  let testHits = 0;
  let generatedHits = 0;
  let configHits = 0;
  let fixtureHits = 0;
  const total = contentSnippets.length || 1;

  for (const snippet of contentSnippets) {
    if (TEST_CONTENT_RE.test(snippet)) testHits++;
    if (GENERATED_RE.test(snippet)) generatedHits++;
    if (CONFIG_CONTENT_RE.test(snippet)) configHits++;
    if (FIXTURE_CONTENT_RE.test(snippet)) fixtureHits++;
  }

  if (generatedHits / total > 0.5) {
    return { purpose: 'generated', production: false, productionFileCount: 0, confidence: 'high' };
  }

  if (testHits / total > 0.5) {
    return { purpose: 'tests', production: false, productionFileCount: 0, confidence: 'high' };
  }

  if (fixtureHits / total > 0.5) {
    return { purpose: 'fixtures', production: false, productionFileCount: 0, confidence: 'high' };
  }

  // 3. Config: mostly config-extension files or config content
  const configFileCount = allFileNames.filter(f => CONFIG_EXT_RE.test(f)).length;
  const configFileRatio = allFileNames.length > 0 ? configFileCount / allFileNames.length : 0;
  if (configFileRatio > 0.5 || (configHits / total > 0.5 && configFileRatio > 0.3)) {
    return { purpose: 'config', production: false, productionFileCount: 0, confidence: 'high' };
  }

  // 4. Production module — subtract non-prod files from count
  const hint = purposeHintFromDirName(dirName);
  const prodCount = Math.max(0, totalFileCount - nonProdFiles);

  const hasContentSignals = contentSnippets.length > 0 && (testHits > 0 || generatedHits > 0 || configHits > 0 || fixtureHits > 0);
  const hasHint = hint !== 'unknown';
  const confidence: ClassificationConfidence =
    hasHint ? 'high' :
    hasContentSignals ? 'medium' :
    'low';

  return { purpose: hint, production: true, productionFileCount: prodCount, confidence };
}

/**
 * Extract import specifiers from file content using polyglot regex patterns.
 * Supports JS/TS, Python, and Go.
 */
export function extractImports(content: string, filePath: string): string[] {
  const ext = path.extname(filePath);
  const imports: string[] = [];

  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    for (const m of content.matchAll(new RegExp(JS_IMPORT_RE.source, 'g'))) {
      const spec = m[1] ?? m[2];
      if (spec) imports.push(spec);
    }
  } else if (ext === '.py') {
    for (const m of content.matchAll(new RegExp(PY_IMPORT_RE.source, 'gm'))) {
      const spec = m[1] ?? m[2];
      if (spec) imports.push(spec);
    }
  } else if (ext === '.go') {
    for (const m of content.matchAll(new RegExp(GO_IMPORT_RE.source, 'g'))) {
      if (m[1]) imports.push(m[1]);
    }
  } else if (ext === '.rs') {
    // Rust: use crate::..., use std::..., use super::...
    for (const m of content.matchAll(/\buse\s+((?:crate|super|self|std)\b[\w:]+)/g)) {
      if (m[1]) imports.push(m[1]);
    }
  } else if (ext === '.java' || ext === '.kt' || ext === '.kts' || ext === '.scala') {
    // Java/Kotlin/Scala: import package.Class
    for (const m of content.matchAll(/\bimport\s+([\w.]+)/g)) {
      if (m[1]) imports.push(m[1]);
    }
  } else if (ext === '.rb') {
    // Ruby: require 'lib' or require_relative 'path'
    for (const m of content.matchAll(/\brequire(?:_relative)?\s+['"]([^'"]+)['"]/g)) {
      if (m[1]) imports.push(m[1]);
    }
  } else if (ext === '.cs') {
    // C#: using Namespace;
    for (const m of content.matchAll(/\busing\s+([\w.]+)\s*;/g)) {
      if (m[1]) imports.push(m[1]);
    }
  } else if (ext === '.swift') {
    // Swift: import Module
    for (const m of content.matchAll(/\bimport\s+(\w+)/g)) {
      if (m[1]) imports.push(m[1]);
    }
  } else if (ext === '.ex' || ext === '.exs') {
    // Elixir: alias/import/use Module
    for (const m of content.matchAll(/\b(?:alias|import|use)\s+([\w.]+)/g)) {
      if (m[1]) imports.push(m[1]);
    }
  } else if (ext === '.php') {
    // PHP: use Namespace\Class;
    for (const m of content.matchAll(/\buse\s+([\w\\]+)/g)) {
      if (m[1]) imports.push(m[1]);
    }
  } else if (ext === '.dart') {
    // Dart: import 'package:...';
    for (const m of content.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) {
      if (m[1]) imports.push(m[1]);
    }
  } else if (ext === '.c' || ext === '.cpp' || ext === '.h' || ext === '.hpp') {
    // C/C++: #include "local.h" (skip <system.h>)
    for (const m of content.matchAll(/#include\s+"([^"]+)"/g)) {
      if (m[1]) imports.push(m[1]);
    }
  } else if (ext === '.hs') {
    // Haskell: import Module.Name
    // eslint-disable-next-line security/detect-unsafe-regex
    for (const m of content.matchAll(/\bimport\s+(?:qualified\s+)?([\w.]+)/g)) {
      if (m[1]) imports.push(m[1]);
    }
  }

  return imports;
}

/**
 * Resolve a relative import specifier to a module path relative to projectRoot.
 * Returns null for non-relative (package) imports.
 */
export function resolveImportToModule(
  specifier: string,
  sourceFile: string,
  projectRoot: string,
  modulePaths: string[],
): string | null {
  if (!specifier.startsWith('.')) return null;

  const sourceDir = path.dirname(sourceFile);
  const resolved = path.resolve(sourceDir, specifier);
  const relative = path.relative(projectRoot, resolved);

  for (const mod of modulePaths) {
    if (relative === mod || relative.startsWith(mod + '/') || relative.startsWith(mod + path.sep)) {
      return mod;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Graph algorithms — pure functions for dependency graph analysis
// ---------------------------------------------------------------------------

/**
 * Invert the dependency edge map: for each "A imports B" edge, produce "B is imported by A".
 */
export function computeReverseEdges(edges: Record<string, string[]>): Record<string, string[]> {
  const reverse: Record<string, string[]> = {};
  for (const [source, targets] of Object.entries(edges)) {
    for (const target of targets) {
      (reverse[target] ??= []).push(source);
    }
  }
  return reverse;
}

/**
 * Detect dependency cycles using iterative DFS with explicit stacks (no recursion).
 * Returns an array of cycles, each represented as a path array (e.g., ["a", "b", "a"]).
 * Caps at 10 cycles to avoid blowing up on highly cyclical graphs.
 */
export function detectCycles(edges: Record<string, string[]>): string[][] {
  const MAX_CYCLES = 10;
  const cycles: string[][] = [];
  const allNodes = new Set<string>([
    ...Object.keys(edges),
    ...Object.values(edges).flat(),
  ]);

  const visited = new Set<string>();
  const finished = new Set<string>();

  for (const startNode of allNodes) {
    if (visited.has(startNode) || cycles.length >= MAX_CYCLES) continue;

    // Iterative DFS — stack entries: [node, index into adjacency list]
    const stack: Array<[string, number]> = [[startNode, 0]];
    const pathSet = new Set<string>([startNode]);
    const pathList: string[] = [startNode];
    visited.add(startNode);

    while (stack.length > 0 && cycles.length < MAX_CYCLES) {
      const [node, idx] = stack[stack.length - 1];
      const neighbors = edges[node] ?? [];

      if (idx >= neighbors.length) {
        // Done with this node — backtrack
        stack.pop();
        pathSet.delete(node);
        pathList.pop();
        finished.add(node);
        continue;
      }

      // Advance to next neighbor
      stack[stack.length - 1] = [node, idx + 1];
      const neighbor = neighbors[idx];

      if (pathSet.has(neighbor)) {
        // Found a cycle — extract the cycle path
        const cycleStart = pathList.indexOf(neighbor);
        const cyclePath = [...pathList.slice(cycleStart), neighbor];
        // Deduplicate: normalize cycle by starting from the lexicographically smallest node
        const minIdx = cyclePath.slice(0, -1).reduce(
          (mi, _n, i, arr) => arr[i] < arr[mi] ? i : mi, 0,
        );
        const normalized = [...cyclePath.slice(minIdx, -1), ...cyclePath.slice(0, minIdx), cyclePath.slice(minIdx, -1)[0]];
        const key = normalized.join(' → ');
        if (!cycles.some(c => c.join(' → ') === key)) {
          cycles.push(normalized);
        }
      } else if (!visited.has(neighbor)) {
        visited.add(neighbor);
        pathSet.add(neighbor);
        pathList.push(neighbor);
        stack.push([neighbor, 0]);
      }
    }
  }

  return cycles;
}

/**
 * Compute aggregate graph topology metrics from module list and edges.
 * Hub: fan_in >= 3. Leaf: fan_out > 0 but fan_in === 0. Orphan: fan_in === 0 and fan_out === 0.
 */
export function computeGraphMetrics(
  modules: ModuleEntry[],
  edges: Record<string, string[]>,
  reverseEdges: Record<string, string[]>,
): GraphMetrics {
  const hub_modules: string[] = [];
  const orphan_modules: string[] = [];
  const leaf_modules: string[] = [];

  for (const mod of modules) {
    const fanIn = (reverseEdges[mod.path] ?? []).length;
    const fanOut = (edges[mod.path] ?? []).length;

    if (fanIn >= 3) hub_modules.push(mod.path);
    if (fanIn === 0 && fanOut === 0) orphan_modules.push(mod.path);
    else if (fanIn === 0 && fanOut > 0) leaf_modules.push(mod.path);
  }

  return { hub_modules, orphan_modules, leaf_modules };
}

/**
 * Format a codebase index for injection into a scout prompt.
 *
 * Chunks modules (15 per chunk) and rotates by cycle number so all modules
 * get exposure over multiple cycles. Includes untested modules, hotspots,
 * and entrypoints.
 */
export function formatIndexForPrompt(index: CodebaseIndex, scoutCycle: number): string {
  const { modules, dependency_edges, untested_modules, large_files, entrypoints } = index;

  if (modules.length === 0) {
    return '## Codebase Structure\n\nNo modules detected.';
  }

  const totalChunks = Math.max(1, Math.ceil(modules.length / CHUNK_SIZE));
  const chunkIndex = scoutCycle % totalChunks;
  const offset = chunkIndex * CHUNK_SIZE;
  const focusModules = modules.slice(offset, offset + CHUNK_SIZE);
  const otherModules = modules.filter((_, i) => i < offset || i >= offset + CHUNK_SIZE);

  const parts: string[] = [];

  parts.push(`## Codebase Structure (chunk ${chunkIndex + 1}/${totalChunks})`);
  parts.push('');
  parts.push('### Modules in Focus This Cycle');

  for (const mod of focusModules) {
    const deps = dependency_edges[mod.path];
    const depStr = deps ? ` → imports: ${deps.join(', ')}` : '';
    // Append AST-derived export/complexity when available
    const astSuffix = mod.export_count !== null && mod.export_count !== undefined
      ? ` | ${mod.export_count} exports${mod.avg_complexity !== null && mod.avg_complexity !== undefined ? ` (complexity: ${mod.avg_complexity.toFixed(1)})` : ''}`
      : '';
    parts.push(`${mod.path}/ — ${mod.file_count} files (${mod.purpose})${depStr}${astSuffix}`);
  }

  if (otherModules.length > 0) {
    parts.push('');
    parts.push('### Other Modules (not in focus — available for future cycles)');
    parts.push(otherModules.map(m => m.path + '/').join(', '));
  }

  if (untested_modules.length > 0) {
    parts.push('');
    parts.push('### Untested Modules (context only — do NOT prioritize writing tests for these)');
    parts.push(untested_modules.map(m => m + '/').join(', '));
  }

  if (large_files.length > 0) {
    parts.push('');
    parts.push('### Complexity Hotspots (>300 LOC)');
    parts.push(large_files.map(f => `${f.path} (${f.lines})`).join(', '));
  }

  if (entrypoints.length > 0) {
    parts.push('');
    parts.push('### Entrypoints');
    parts.push(entrypoints.join(', '));
  }

  // Graph insights — compact section from dependency graph analysis
  const graphLines: string[] = [];
  if (index.graph_metrics) {
    const { hub_modules, orphan_modules } = index.graph_metrics;
    if (hub_modules.length > 0) {
      graphLines.push(`Hub modules (3+ dependents): ${hub_modules.join(', ')}`);
    }
    if (orphan_modules.length > 0) {
      graphLines.push(`Orphan modules (no dependencies): ${orphan_modules.slice(0, 10).join(', ')}`);
    }
  }
  if (index.dependency_cycles && index.dependency_cycles.length > 0) {
    const formatted = index.dependency_cycles
      .slice(0, 5)
      .map(c => c.join(' → '));
    graphLines.push(`Circular dependencies: ${formatted.join('; ')}`);
  }
  if (graphLines.length > 0) {
    parts.push('');
    parts.push('### Dependency Graph Insights');
    parts.push(graphLines.join('\n'));
  }

  return parts.join('\n');
}
