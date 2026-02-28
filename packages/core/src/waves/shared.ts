/**
 * Wave scheduling shared algorithms — pure functions for conflict-free
 * parallel execution partitioning.
 *
 * Detects potential merge conflicts between proposals based on file paths,
 * sibling files, shared directories, monorepo packages, and conflict-prone
 * hub files (index.ts, configs, etc.).
 *
 * No filesystem, git, or child_process I/O.
 */

import type { CodebaseIndex, SymbolRange } from '../codebase-index/shared.js';
import type { SectorState } from '../sectors/shared.js';

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

// ---------------------------------------------------------------------------
// Wave partitioning
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Symbol enrichment
// ---------------------------------------------------------------------------

/**
 * Map from relative file path to its top-level symbols.
 * Typically loaded from the AST cache.
 */
export type SymbolMap = Record<string, SymbolRange[]>;

/**
 * Enrich proposals with target_symbols from a pre-loaded AST symbol map.
 *
 * For each proposal that lacks target_symbols, looks up its files in the
 * symbol map and collects all symbol names. This makes symbol-aware conflict
 * detection work automatically without relying on scout LLM compliance.
 *
 * Only sets target_symbols when ALL of a proposal's files have symbol data.
 * If any file is missing from the map, we leave target_symbols unset so
 * conflict detection falls back to the conservative path-based check.
 *
 * Mutates proposals in place for efficiency.
 */
export function enrichWithSymbols<T extends { files: string[]; target_symbols?: string[] }>(
  proposals: T[],
  symbolMap: SymbolMap,
): void {
  for (const p of proposals) {
    // Don't overwrite scout-provided symbols
    if (p.target_symbols?.length) continue;
    if (p.files.length === 0) continue;

    // Only concrete file paths (no globs)
    const concreteFiles = p.files.filter(f => !f.includes('*'));
    if (concreteFiles.length === 0) continue;

    // All files must have symbol data for the enrichment to be reliable
    const allSymbols: string[] = [];
    let allResolved = true;
    for (const file of concreteFiles) {
      const symbols = symbolMap[file];
      if (!symbols) {
        allResolved = false;
        break;
      }
      for (const s of symbols) {
        allSymbols.push(s.name);
      }
    }

    if (allResolved && allSymbols.length > 0) {
      // Deduplicate
      p.target_symbols = [...new Set(allSymbols)];
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-merge conflict prediction
// ---------------------------------------------------------------------------

/**
 * Predict whether merging two sets of file changes will conflict,
 * based on symbol-level line ranges.
 *
 * For each file both branches modified, checks if the modified symbol ranges
 * overlap. Returns:
 * - 'safe'    — all shared files have disjoint symbol ranges (merge likely succeeds)
 * - 'risky'   — at least one shared file has overlapping symbol ranges (merge may conflict)
 * - 'unknown' — symbol data missing for one or more shared files (can't predict)
 */
export function predictMergeConflict(
  filesA: string[],
  filesB: string[],
  symbolsA: Record<string, string[]>,
  symbolsB: Record<string, string[]>,
  symbolMap: SymbolMap,
): 'safe' | 'risky' | 'unknown' {
  const setB = new Set(filesB);
  const sharedFiles = filesA.filter(f => setB.has(f));

  if (sharedFiles.length === 0) return 'safe';

  for (const file of sharedFiles) {
    const fileSymbols = symbolMap[file];
    const symsA = symbolsA[file];
    const symsB = symbolsB[file];

    // If we don't have symbol data for a shared file, can't predict
    if (!fileSymbols?.length || !symsA?.length || !symsB?.length) return 'unknown';

    // Build a map of symbol name → line range for quick lookup
    const rangeByName = new Map(fileSymbols.map(s => [s.name, s]));

    // Check if any symbol is modified by both branches
    for (const symName of symsA) {
      if (!symsB.includes(symName)) continue;

      // Same symbol modified by both branches — check line range overlap
      const range = rangeByName.get(symName);
      if (range) {
        // Both branches touch the same symbol → likely conflict
        return 'risky';
      }
    }

    // Even if no named symbol overlaps, check if any line ranges overlap
    // by matching unnamed modifications
    const rangesA = symsA.map(s => rangeByName.get(s)).filter(Boolean) as SymbolRange[];
    const rangesB = symsB.map(s => rangeByName.get(s)).filter(Boolean) as SymbolRange[];

    for (const ra of rangesA) {
      for (const rb of rangesB) {
        // Line range overlap check
        if (ra.startLine <= rb.endLine && rb.startLine <= ra.endLine) {
          return 'risky';
        }
      }
    }
  }

  return 'safe';
}

/**
 * Reorder a list of ticket branches for merge, placing "safe" merges first
 * and "risky" ones last. This minimizes the chance of early merge failures
 * blocking later safe merges.
 *
 * Takes already-merged files (from the milestone) and each candidate's files+symbols.
 * Returns indices sorted from safest to riskiest.
 */
export function orderMergeSequence(
  candidates: Array<{
    files: string[];
    targetSymbols: Record<string, string[]>;
  }>,
  symbolMap: SymbolMap,
): number[] {
  // Score each candidate: count how many other candidates it conflicts with
  const scores = candidates.map((c, i) => {
    let riskyCount = 0;
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const prediction = predictMergeConflict(
        c.files, candidates[j].files,
        c.targetSymbols, candidates[j].targetSymbols,
        symbolMap,
      );
      if (prediction === 'risky') riskyCount++;
    }
    return { index: i, riskyCount };
  });

  // Sort: fewest conflicts first (safest merges go first)
  scores.sort((a, b) => a.riskyCount - b.riskyCount);
  return scores.map(s => s.index);
}

// ---------------------------------------------------------------------------
// Scout escalation
// ---------------------------------------------------------------------------

/**
 * Build escalation prompt text for scout retries.
 * Suggests unexplored modules and fresh angles when previous attempts found nothing.
 */
export function buildScoutEscalation(
  retryCount: number,
  scoutedDirs: string[],
  codebaseIndex: CodebaseIndex | null,
  sectorState?: SectorState,
): string {
  const parts = [
    '## Previous Attempts Found Nothing — Fresh Approach Required',
    '',
  ];

  if (scoutedDirs.length > 0) {
    parts.push('### What Was Already Tried');
    for (const dir of scoutedDirs) {
      parts.push(`- Scouted \`${dir}\``);
    }
    parts.push('');
  }

  // Suggest unexplored modules from codebase index
  const exploredSet = new Set(scoutedDirs.map(d => d.replace(/\/$/, '')));
  const unexplored: string[] = [];
  if (codebaseIndex) {
    for (const mod of codebaseIndex.modules) {
      if (!exploredSet.has(mod.path) && !exploredSet.has(mod.path + '/')) {
        unexplored.push(mod.path);
      }
    }
  }

  // Sort unexplored by sector history when available
  if (sectorState && unexplored.length > 0) {
    const sectorByPath = new Map(sectorState.sectors.map(s => [s.path, s]));
    unexplored.sort((a, b) => {
      const sa = sectorByPath.get(a);
      const sb = sectorByPath.get(b);
      // Fewer scans first
      const scanA = sa?.scanCount ?? 0;
      const scanB = sb?.scanCount ?? 0;
      if (scanA !== scanB) return scanA - scanB;
      // Higher yield first
      const yieldA = sa?.proposalYield ?? 0;
      const yieldB = sb?.proposalYield ?? 0;
      return yieldB - yieldA;
    });
  }

  parts.push('### What to Do Differently');
  parts.push('');
  parts.push('Knowing everything from the attempts above, take a completely different angle:');
  parts.push('- Do NOT re-read the directories listed above.');
  if (unexplored.length > 0) {
    parts.push(`- Try unexplored areas: ${unexplored.slice(0, 8).map(d => `\`${d}\``).join(', ')}`);
  }
  parts.push('- Switch categories: if you looked for bugs, look for tests. If tests, try security.');
  parts.push('- Read at least 15 NEW source files.');
  parts.push('- If genuinely nothing to improve, explain your analysis across all attempts.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Structural merge resolution
// ---------------------------------------------------------------------------

/**
 * A block of lines belonging to a single symbol (or inter-symbol gap).
 * Blocks are the atomic unit for structural merge — if two sides modified
 * different blocks, the merge is safe.
 */
interface MergeBlock {
  /** Symbol name, or null for inter-symbol gaps (imports, whitespace). */
  symbol: string | null;
  /** 0-based start line (inclusive). */
  startLine: number;
  /** 0-based end line (exclusive). */
  endLine: number;
  /** The actual lines of content. */
  lines: string[];
}

/**
 * Split file content into symbol-aligned blocks using SymbolRange data.
 * Produces a sequence of blocks covering the entire file: inter-symbol gaps
 * are their own blocks (symbol=null), and each symbol gets its own block.
 *
 * SymbolRanges use 1-based line numbers; this function converts to 0-based
 * for array indexing.
 */
function splitIntoBlocks(lines: string[], symbols: SymbolRange[]): MergeBlock[] {
  const blocks: MergeBlock[] = [];

  // Sort symbols by start line
  const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine);

  let cursor = 0; // 0-based current line

  for (const sym of sorted) {
    const symStart = sym.startLine - 1; // convert 1-based to 0-based
    const symEnd = sym.endLine; // 1-based endLine → 0-based exclusive

    // Gap before this symbol
    if (cursor < symStart) {
      blocks.push({
        symbol: null,
        startLine: cursor,
        endLine: symStart,
        lines: lines.slice(cursor, symStart),
      });
    }

    // The symbol block
    const effectiveStart = Math.max(cursor, symStart);
    const effectiveEnd = Math.min(symEnd, lines.length);
    blocks.push({
      symbol: sym.name,
      startLine: effectiveStart,
      endLine: effectiveEnd,
      lines: lines.slice(effectiveStart, effectiveEnd),
    });
    cursor = effectiveEnd;
  }

  // Trailing gap after last symbol
  if (cursor < lines.length) {
    blocks.push({
      symbol: null,
      startLine: cursor,
      endLine: lines.length,
      lines: lines.slice(cursor),
    });
  }

  return blocks;
}

/**
 * Check if two arrays of strings are identical.
 */
function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Attempt to structurally resolve a merge conflict for a single file.
 *
 * Given three versions (base, ours, theirs) and symbol ranges for each,
 * splits each version into symbol-aligned blocks. If modifications from
 * "ours" and "theirs" affect disjoint symbols, produces a resolved version
 * that includes both sets of changes.
 *
 * Returns the resolved content as a string, or null if:
 * - Symbol data is unavailable for any version
 * - Both sides modified the same symbol (true conflict)
 * - Block structure doesn't align across versions (structural shift)
 *
 * Conservative by design: returns null on any ambiguity.
 */
export function tryStructuralMerge(
  baseContent: string,
  oursContent: string,
  theirsContent: string,
  baseSymbols: SymbolRange[],
  oursSymbols: SymbolRange[],
  theirsSymbols: SymbolRange[],
): string | null {
  if (!baseSymbols.length || !oursSymbols.length || !theirsSymbols.length) {
    return null;
  }

  const baseLines = baseContent.split('\n');
  const oursLines = oursContent.split('\n');
  const theirsLines = theirsContent.split('\n');

  const baseBlocks = splitIntoBlocks(baseLines, baseSymbols);
  const oursBlocks = splitIntoBlocks(oursLines, oursSymbols);
  const theirsBlocks = splitIntoBlocks(theirsLines, theirsSymbols);

  // Block counts must match — structural shifts (added/removed symbols) are too risky
  if (baseBlocks.length !== oursBlocks.length || baseBlocks.length !== theirsBlocks.length) {
    return null;
  }

  // Symbol names must match in order — reordered symbols are too risky
  for (let i = 0; i < baseBlocks.length; i++) {
    if (baseBlocks[i].symbol !== oursBlocks[i].symbol || baseBlocks[i].symbol !== theirsBlocks[i].symbol) {
      return null;
    }
  }

  // For each block, determine which side(s) modified it
  const resolvedLines: string[] = [];
  for (let i = 0; i < baseBlocks.length; i++) {
    const base = baseBlocks[i].lines;
    const ours = oursBlocks[i].lines;
    const theirs = theirsBlocks[i].lines;

    const oursChanged = !linesEqual(base, ours);
    const theirsChanged = !linesEqual(base, theirs);

    if (oursChanged && theirsChanged) {
      // Both sides modified the same block — true conflict, bail out
      return null;
    } else if (oursChanged) {
      resolvedLines.push(...ours);
    } else if (theirsChanged) {
      resolvedLines.push(...theirs);
    } else {
      // Neither side changed — use base
      resolvedLines.push(...base);
    }
  }

  return resolvedLines.join('\n');
}
