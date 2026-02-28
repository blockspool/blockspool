/**
 * Merge resolution and symbol enrichment — pure functions for AST-aware
 * merge conflict prediction, structural merge, and scout escalation.
 *
 * No filesystem, git, or child_process I/O.
 */

import type { CodebaseIndex, SymbolRange } from '../codebase-index/shared.js';
import type { SectorState } from '../sectors/shared.js';

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
