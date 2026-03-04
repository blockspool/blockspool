/**
 * Load user-defined exclude patterns from .promptwheel/exclude.json.
 *
 * Returns an array of glob patterns (e.g. ["cloud", "packs", "docs"]).
 * Returns [] if the file is missing or invalid.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function loadExcludePatterns(repoRoot: string): string[] {
  const filePath = path.join(repoRoot, '.promptwheel', 'exclude.json');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    return [];
  }

  return parsed as string[];
}
