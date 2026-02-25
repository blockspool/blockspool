/**
 * Mtime-based per-file AST analysis cache.
 *
 * Stores import/export/complexity results per source file. Invalidated when
 * a file's mtime or size changes. Stale entries (files no longer in module set)
 * are pruned on save.
 *
 * Cache location: .promptwheel/ast-cache.json
 * ~200 bytes per entry → ~200KB for 1000 files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExportEntry } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AstCacheEntry {
  mtime: number;
  size: number;
  imports: string[];
  exports: ExportEntry[];
  complexity: number;
}

export type AstCache = Record<string, AstCacheEntry>;

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function getCachePath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', 'ast-cache.json');
}

/** Load the AST cache from disk. Returns empty cache if missing or corrupted. */
export function loadAstCache(repoRoot: string): AstCache {
  try {
    const cachePath = getCachePath(repoRoot);
    if (!fs.existsSync(cachePath)) return {};
    const raw = fs.readFileSync(cachePath, 'utf-8');
    if (!raw.trim()) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return data as AstCache;
  } catch {
    return {};
  }
}

/**
 * Save the AST cache to disk. Prunes entries for files not in the current
 * module set to prevent unbounded growth.
 */
export function saveAstCache(repoRoot: string, cache: AstCache, currentFiles?: Set<string>): void {
  const cachePath = getCachePath(repoRoot);
  const tmp = cachePath + '.tmp';
  try {
    // Prune stale entries
    const pruned: AstCache = {};
    for (const [relPath, entry] of Object.entries(cache)) {
      if (!currentFiles || currentFiles.has(relPath)) {
        pruned[relPath] = entry;
      }
    }

    // Ensure directory exists
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(tmp, JSON.stringify(pruned));
    fs.renameSync(tmp, cachePath);
  } catch {
    // Cache write failure is non-fatal
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Check if a cache entry is still current for a given file. */
export function isEntryCurrent(entry: AstCacheEntry | undefined, mtime: number, size: number): boolean {
  if (!entry) return false;
  return entry.mtime === mtime && entry.size === size;
}
