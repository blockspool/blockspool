/**
 * Conflict detection — pure functions that determine whether two proposals
 * can safely execute in parallel or risk merge conflicts.
 *
 * Checks file path overlap, sibling files, directory proximity, import chains,
 * call-graph edges, and monorepo package boundaries.
 *
 * No filesystem, git, or child_process I/O.
 */

import type { CallEdge } from '../codebase-index/shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConflictSensitivity = 'strict' | 'normal' | 'relaxed';

export interface ConflictDetectionOptions {
  /**
   * Sensitivity level:
   * - 'strict': Any shared directory or package = conflict (safest, most sequential)
   * - 'normal': Sibling files + conflict-prone files + shared dirs (balanced)
   * - 'relaxed': Only direct file overlap + glob overlap (most parallel, riskier)
   */
  sensitivity?: ConflictSensitivity;
  /**
   * Optional dependency graph edges (module → modules it imports).
   * When provided, proposals touching modules connected by import chains
   * are treated as conflicting at normal/strict sensitivity, ensuring the
   * dependency is executed before the consumer.
   */
  edges?: Record<string, string[]>;
  /**
   * Optional call-graph edges from AST analysis.
   * When provided, proposals whose target_symbols are connected by
   * caller→callee relationships are treated as conflicting, even across
   * different files/modules.
   */
  callEdges?: CallEdge[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Files that frequently cause merge conflicts when multiple tickets
 * touch the same directory. These are "hub" files that re-export or
 * aggregate content from sibling files.
 */
export const CONFLICT_PRONE_FILENAMES = new Set([
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  'mod.ts',           // Deno convention
  'mod.js',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'jest.config.js',
  'jest.config.ts',
  '.eslintrc.js',
  '.eslintrc.json',
  'eslint.config.js',
  'eslint.config.mjs',
  '__init__.py',      // Python
  'Cargo.toml',       // Rust
  'go.mod',           // Go
  'build.gradle',     // Java/Kotlin
  'pom.xml',          // Maven
  'Gemfile',          // Ruby
  'mix.exs',          // Elixir
  'Package.swift',    // Swift
  'pubspec.yaml',     // Dart/Flutter
  'build.sbt',        // Scala
  'stack.yaml',       // Haskell
  'build.zig',        // Zig
  'CMakeLists.txt',   // C/C++
]);

/**
 * Directory patterns that indicate shared/common code.
 * Files in these directories are more likely to be touched by multiple tickets.
 */
export const SHARED_DIRECTORY_PATTERNS = [
  /\/shared\//,
  /\/common\//,
  /\/utils\//,
  /\/helpers\//,
  /\/lib\//,
  /\/types\//,
  /\/interfaces\//,
  /\/constants\//,
  /\/config\//,
];

/** Monorepo top-level directory patterns. */
export const PACKAGE_PATTERN = /^(packages|apps|libs|modules)\/([^/]+)/;

/** Default directory overlap threshold for normal mode. */
export const DIRECTORY_OVERLAP_NORMAL = 0.3;

/** Default directory overlap threshold for strict mode. */
export const DIRECTORY_OVERLAP_STRICT = 0.2;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Extract the directory and filename from a path. */
export function parsePath(filePath: string): { dir: string; filename: string } {
  const normalized = filePath.replace(/^\.\//, '').replace(/\/$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) {
    return { dir: '.', filename: normalized };
  }
  return {
    dir: normalized.slice(0, lastSlash),
    filename: normalized.slice(lastSlash + 1),
  };
}

/**
 * Check if two file paths overlap: exact match, directory containment,
 * or glob pattern overlap.
 */
export function pathsOverlap(pathA: string, pathB: string): boolean {
  // Normalize paths (remove trailing slashes, handle ./prefix)
  const normA = pathA.replace(/^\.\//, '').replace(/\/$/, '');
  const normB = pathB.replace(/^\.\//, '').replace(/\/$/, '');

  // Exact match
  if (normA === normB) {
    return true;
  }

  // One is prefix of other (directory containment)
  if (normA.startsWith(normB + '/') || normB.startsWith(normA + '/')) {
    return true;
  }

  // Check for glob pattern overlaps
  const hasGlobA = normA.includes('*');
  const hasGlobB = normB.includes('*');

  if (hasGlobA || hasGlobB) {
    const baseA = normA.split('*')[0].replace(/\/$/, '');
    const baseB = normB.split('*')[0].replace(/\/$/, '');

    if (baseA === baseB || baseA.startsWith(baseB + '/') || baseB.startsWith(baseA + '/')) {
      return true;
    }
  }

  return false;
}

/**
 * Check if two sets of file paths share directories above a threshold.
 * Used for semantic conflict detection in wave scheduling.
 */
export function directoriesOverlap(pathsA: string[], pathsB: string[], threshold = 0.3): boolean {
  const dirsA = new Set(pathsA.map(p => parsePath(p).dir));
  const dirsB = new Set(pathsB.map(p => parsePath(p).dir));
  if (dirsA.size === 0 || dirsB.size === 0) return false;
  let n = 0;
  for (const d of dirsA) { if (dirsB.has(d)) n++; }
  return (n / Math.min(dirsA.size, dirsB.size)) >= threshold;
}

// ---------------------------------------------------------------------------
// Conflict detection helpers
// ---------------------------------------------------------------------------

/** Check if a file is conflict-prone (index files, configs, etc.) */
export function isConflictProneFile(filePath: string): boolean {
  const { filename } = parsePath(filePath);
  return CONFLICT_PRONE_FILENAMES.has(filename);
}

/** Check if a path is in a shared/common directory. */
export function isInSharedDirectory(filePath: string): boolean {
  return SHARED_DIRECTORY_PATTERNS.some(pattern => pattern.test(filePath));
}

/** Get all unique directories from a list of file paths, including parent hierarchy. */
export function getDirectories(files: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    const { dir } = parsePath(file);
    dirs.add(dir);
    // Also add parent directories for hierarchical conflict detection
    const parts = dir.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return dirs;
}

/**
 * Check if two proposals have sibling files (different files in the same directory).
 */
export function hasSiblingFiles(filesA: string[], filesB: string[]): boolean {
  const dirsA = new Set(filesA.map(f => parsePath(f).dir));
  const dirsB = new Set(filesB.map(f => parsePath(f).dir));

  for (const dir of dirsA) {
    if (dirsB.has(dir)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if either proposal touches conflict-prone files in overlapping directories.
 */
export function hasConflictProneOverlap(filesA: string[], filesB: string[]): boolean {
  const dirsA = new Set(filesA.map(f => parsePath(f).dir));
  const dirsB = new Set(filesB.map(f => parsePath(f).dir));

  for (const file of [...filesA, ...filesB]) {
    if (isConflictProneFile(file)) {
      const { dir } = parsePath(file);
      if (dirsA.has(dir) && dirsB.has(dir)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if proposals share a common parent directory that might have
 * configuration or index files affected by both changes.
 */
export function hasSharedParentConflict(filesA: string[], filesB: string[]): boolean {
  const dirsA = getDirectories(filesA);
  const dirsB = getDirectories(filesB);

  for (const dir of dirsA) {
    if (dirsB.has(dir) && isInSharedDirectory(dir + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Monorepo-aware: check if both proposals touch the same package.
 * Common patterns: packages/*, apps/*, libs/*, modules/*
 */
export function touchesSamePackage(filesA: string[], filesB: string[]): boolean {
  const packagesA = new Set<string>();
  const packagesB = new Set<string>();

  for (const file of filesA) {
    const match = file.match(PACKAGE_PATTERN);
    if (match) packagesA.add(match[0]);
  }

  for (const file of filesB) {
    const match = file.match(PACKAGE_PATTERN);
    if (match) packagesB.add(match[0]);
  }

  for (const pkg of packagesA) {
    if (packagesB.has(pkg)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main conflict detection
// ---------------------------------------------------------------------------

/**
 * Resolve files to their containing module path in the dependency graph.
 * A file `src/core/index.ts` matches module `src/core` if that key exists in edges.
 */
function resolveModules(files: string[], edges: Record<string, string[]>): Set<string> {
  const mods = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = parts.slice(0, i).join('/');
      if (candidate in edges) {
        mods.add(candidate);
        break; // most-specific match
      }
    }
  }
  return mods;
}

/**
 * Check if two sets of modules are connected by a direct import edge.
 * Returns true if any module in A imports any module in B, or vice versa.
 */
export function hasImportChainConflict(
  filesA: string[],
  filesB: string[],
  edges: Record<string, string[]>,
): boolean {
  const modsA = resolveModules(filesA, edges);
  const modsB = resolveModules(filesB, edges);
  if (modsA.size === 0 || modsB.size === 0) return false;

  // Check: does any module in A import any module in B?
  for (const modA of modsA) {
    const deps = edges[modA];
    if (deps) {
      for (const dep of deps) {
        if (modsB.has(dep)) return true;
      }
    }
  }
  // Check reverse: does any module in B import any module in A?
  for (const modB of modsB) {
    const deps = edges[modB];
    if (deps) {
      for (const dep of deps) {
        if (modsA.has(dep)) return true;
      }
    }
  }
  return false;
}

/**
 * Check if two sets of target symbols are connected by a caller→callee edge.
 * Returns true if any symbol in A calls any symbol in B, or vice versa.
 */
export function hasCallGraphConflict(
  symbolsA: string[],
  symbolsB: string[],
  callEdges: CallEdge[],
): boolean {
  if (symbolsA.length === 0 || symbolsB.length === 0) return false;
  const setA = new Set(symbolsA);
  const setB = new Set(symbolsB);
  for (const edge of callEdges) {
    // A calls B or B calls A
    if ((setA.has(edge.caller) && setB.has(edge.callee)) ||
        (setB.has(edge.caller) && setA.has(edge.callee))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if two proposals have a potential conflict based on their file lists.
 *
 * When both proposals provide `target_symbols` and their file paths overlap,
 * an AST-aware escape hatch checks whether the targeted symbols are disjoint.
 * If symbols don't overlap, the proposals can safely run in parallel even
 * though they touch the same file.
 */
export function proposalsConflict<T extends { files: string[]; category?: string; target_symbols?: string[] }>(
  a: T,
  b: T,
  options: ConflictDetectionOptions = {}
): boolean {
  const { sensitivity = 'normal' } = options;

  // Always check: direct file path overlap (exact match or containment)
  const hasPathOverlap = a.files.some(fA => b.files.some(fB => pathsOverlap(fA, fB)));
  if (hasPathOverlap) {
    // AST-aware escape hatch: if both proposals declare which symbols they
    // modify and those symbol sets are disjoint, they can run in parallel.
    if (a.target_symbols?.length && b.target_symbols?.length) {
      const symbolsA = new Set(a.target_symbols);
      const hasSymbolOverlap = b.target_symbols.some(s => symbolsA.has(s));
      if (!hasSymbolOverlap) {
        // Different symbols in same file — safe to parallelize
        return false;
      }
    }
    return true;
  }

  if (sensitivity === 'relaxed') {
    return false;
  }

  // Normal and strict: check sibling files in same directory
  if (hasSiblingFiles(a.files, b.files)) {
    if (sensitivity === 'strict') {
      return true;
    }
    // Normal: sibling + (conflict-prone OR same category)
    if (hasConflictProneOverlap(a.files, b.files)) {
      return true;
    }
    if (a.category && b.category && a.category === b.category) {
      // AST-aware escape: same category but disjoint symbols → safe
      if (a.target_symbols?.length && b.target_symbols?.length) {
        const symbolsA = new Set(a.target_symbols);
        if (!b.target_symbols.some(s => symbolsA.has(s))) {
          // Different symbols, same category — not a real conflict
          // (skip returning true, fall through to remaining checks)
        } else {
          return true;
        }
      } else {
        return true;
      }
    }
  }

  // Normal and strict: check directory overlap threshold
  if (directoriesOverlap(a.files, b.files, sensitivity === 'strict' ? DIRECTORY_OVERLAP_STRICT : DIRECTORY_OVERLAP_NORMAL)) {
    return true;
  }

  // Normal and strict: import-chain conflict (dependency graph)
  if (options.edges && hasImportChainConflict(a.files, b.files, options.edges)) {
    return true;
  }

  // Normal and strict: call-graph conflict (cross-file caller→callee)
  if (options.callEdges && a.target_symbols?.length && b.target_symbols?.length) {
    if (hasCallGraphConflict(a.target_symbols, b.target_symbols, options.callEdges)) {
      return true;
    }
  }

  // Strict only: same package in monorepo
  if (sensitivity === 'strict' && touchesSamePackage(a.files, b.files)) {
    return true;
  }

  // Strict only: shared parent directory
  if (sensitivity === 'strict' && hasSharedParentConflict(a.files, b.files)) {
    return true;
  }

  return false;
}

/**
 * Partition proposals into conflict-free waves.
 * Proposals with overlapping file paths go into separate waves
 * so they run sequentially, avoiding merge conflicts.
 *
 * Uses a greedy first-fit bin-packing algorithm.
 *
 * @param proposals - List of proposals with file paths
 * @param options - Conflict detection options
 * @returns Array of waves, each containing non-conflicting proposals
 */
export function partitionIntoWaves<T extends { files: string[]; category?: string; target_symbols?: string[] }>(
  proposals: T[],
  options: ConflictDetectionOptions = {}
): T[][] {
  const waves: T[][] = [];

  for (const proposal of proposals) {
    let placed = false;
    for (const wave of waves) {
      const conflicts = wave.some(existing => proposalsConflict(existing, proposal, options));
      if (!conflicts) {
        wave.push(proposal);
        placed = true;
        break;
      }
    }
    if (!placed) {
      waves.push([proposal]);
    }
  }

  return waves;
}
