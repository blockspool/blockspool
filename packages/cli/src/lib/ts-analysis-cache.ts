/**
 * Cache for TypeScript analysis results.
 *
 * Invalidated by tsconfig.json mtime change. The analysis is expensive
 * (10-30s) so we cache aggressively and only re-run when the project
 * configuration changes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TypeScriptAnalysis } from '@promptwheel/core/codebase-index';

export interface TsAnalysisCacheEntry {
  tsconfigMtime: number;
  sourceFileCount: number;
  analysis: TypeScriptAnalysis;
  cachedAt: string;
}

const CACHE_FILE = '.promptwheel/ts-analysis-cache.json';

/**
 * Load cached TypeScript analysis if still valid.
 * Returns null if cache is missing, corrupt, or stale.
 */
export function loadTsAnalysisCache(repoRoot: string): TypeScriptAnalysis | null {
  const cachePath = path.join(repoRoot, CACHE_FILE);
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const entry: TsAnalysisCacheEntry = JSON.parse(raw);

    // Validate tsconfig mtime hasn't changed
    const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) return null;
    const stat = fs.statSync(tsconfigPath);
    if (stat.mtimeMs !== entry.tsconfigMtime) return null;

    return entry.analysis;
  } catch {
    return null;
  }
}

/**
 * Save TypeScript analysis results to cache.
 */
export function saveTsAnalysisCache(
  repoRoot: string,
  analysis: TypeScriptAnalysis,
  sourceFileCount: number,
): void {
  const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
  try {
    const stat = fs.statSync(tsconfigPath);
    const entry: TsAnalysisCacheEntry = {
      tsconfigMtime: stat.mtimeMs,
      sourceFileCount,
      analysis,
      cachedAt: new Date().toISOString(),
    };

    const cachePath = path.join(repoRoot, CACHE_FILE);
    const dir = path.dirname(cachePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2), 'utf-8');
  } catch {
    // Cache write failure is non-fatal
  }
}
