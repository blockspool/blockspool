/**
 * Project guidelines loader for MCP advance prompts.
 *
 * Pure resolution logic and formatting live in @promptwheel/core/guidelines/shared.
 * This file wraps them with filesystem I/O.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ProjectGuidelines,
  type GuidelinesBackend,
  resolveGuidelinesPaths,
} from '@promptwheel/core/guidelines/shared';

// Re-export types and pure functions
export type { ProjectGuidelines } from '@promptwheel/core/guidelines/shared';
export type { GuidelinesBackend } from '@promptwheel/core/guidelines/shared';
export { formatGuidelinesForPrompt } from '@promptwheel/core/guidelines/shared';

export interface GuidelinesOptions {
  backend?: GuidelinesBackend;
  customPath?: string | false | null;
}

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const UNC_PATH_RE = /^[\\/]{2}/;

export function loadGuidelines(
  repoRoot: string,
  opts: GuidelinesOptions = {},
): ProjectGuidelines | null {
  const { backend = 'claude', customPath } = opts;

  if (customPath === false) return null;

  if (typeof customPath === 'string') {
    if (!isSafeGuidelinePath(customPath)) {
      console.warn(`[promptwheel] rejected unsafe guidelines path: ${customPath}`);
      return null;
    }
    return readGuidelinesFile(repoRoot, customPath);
  }

  const [primaryPaths, fallbackPaths] = resolveGuidelinesPaths(backend);
  return searchPaths(repoRoot, primaryPaths) ?? searchPaths(repoRoot, fallbackPaths);
}

function readGuidelinesFile(repoRoot: string, rel: string): ProjectGuidelines | null {
  const canonicalRepoRoot = resolveCanonicalPath(repoRoot);
  const full = path.resolve(canonicalRepoRoot, rel);
  if (!isPathWithinRoot(full, canonicalRepoRoot) || !fs.existsSync(full)) return null;

  try {
    const canonicalFile = resolveCanonicalPath(full);
    if (!isPathWithinRoot(canonicalFile, canonicalRepoRoot)) return null;

    const content = fs.readFileSync(canonicalFile, 'utf-8');
    return { content, source: rel, loadedAt: Date.now() };
  } catch (err) {
    if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      console.warn(`[promptwheel] failed to read guidelines file ${rel}: ${err.message}`);
    }
    return null;
  }
}

function searchPaths(repoRoot: string, paths: string[]): ProjectGuidelines | null {
  for (const rel of paths) {
    const result = readGuidelinesFile(repoRoot, rel);
    if (result) return result;
  }
  return null;
}

function isSafeGuidelinePath(input: string): boolean {
  if (!input || input.includes('\0')) return false;
  if (path.isAbsolute(input) || WINDOWS_ABSOLUTE_PATH_RE.test(input) || UNC_PATH_RE.test(input)) {
    return false;
  }
  const segments = input.split(/[\\/]+/).filter(Boolean);
  return !segments.includes('..');
}

function resolveCanonicalPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath).replace(/[\\/]+$/, '');
  const normalizedCandidate = path.resolve(candidatePath).replace(/[\\/]+$/, '');
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(normalizedRoot + path.sep);
}
