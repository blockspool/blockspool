/**
 * Scope Policy — derives and enforces file-level constraints for tickets.
 *
 * Used by the plan validator and PreToolUse hook to ensure
 * agents only touch files they're allowed to.
 *
 * Shared constants (ALWAYS_DENIED, CREDENTIAL_PATTERNS, FILE_DENY_PATTERNS)
 * and pure algorithms live in @promptwheel/core/scope/shared.
 * This file adds MCP-specific policy derivation and minimatch-based validation.
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { minimatch } from 'minimatch';
import {
  ALWAYS_DENIED,
  FILE_DENY_PATTERNS,
} from '@promptwheel/core/scope/shared';
import {
  assessAdaptiveRisk,
  type Learning,
  type AdaptiveRiskAssessment,
} from '@promptwheel/core/learnings/shared';

// Re-export for existing consumers
export { detectCredentialInContent as containsCredentials } from '@promptwheel/core/scope/shared';

/** True when a path contains glob metacharacters (`*` or `?`). */
function isGlobPattern(p: string): boolean {
  return /[*?]/.test(p);
}

/**
 * Normalize an allowed_path for minimatch (only called for actual globs):
 * - Directory-style paths ending with `/` become `dir/**` (match anything inside)
 */
function normalizeAllowedGlob(glob: string): string {
  let result = glob;
  if (result.endsWith('/')) result = result + '**';
  return result;
}

/**
 * Check whether `candidate` matches `allowedPath`.
 *
 * Exact paths (no `*` or `?`) are string-compared after normalization.
 * Glob patterns are passed through minimatch.
 *
 * This avoids routing literal file paths through a glob engine that
 * misinterprets special characters (brackets, parentheses) common in
 * framework conventions (Next.js `[param]`, route groups `(group)`).
 */
function matchesAllowedPath(candidate: string, allowedPath: string): boolean {
  if (isGlobPattern(allowedPath)) {
    return minimatch(candidate, normalizeAllowedGlob(allowedPath), { dot: true });
  }
  // Exact path — string compare after normalization.
  // Also check with trailing-slash expansion for directory-style paths.
  const normalizedAllowed = normalizePathForMatch(allowedPath);
  if (candidate === normalizedAllowed) return true;
  // Directory match: "cloud/app/foo" allows "cloud/app/foo/bar.ts"
  if (candidate.startsWith(normalizedAllowed + '/')) return true;
  return false;
}

function normalizePathForMatch(filePath: string): string {
  const normalized = filePath
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/$/, '');
}

function canonicalizePathForCheck(targetPath: string): string | null {
  const absolutePath = nodePath.resolve(targetPath);
  try {
    return normalizePathForMatch(nodeFs.realpathSync(absolutePath));
  } catch (err) {
    const code = err instanceof Error && 'code' in err
      ? (err as NodeJS.ErrnoException).code
      : undefined;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return null;
    }

    // For create/write targets that do not exist yet, resolve symlinks in the
    // nearest existing ancestor and append the remaining path segments.
    const suffix: string[] = [];
    let current = absolutePath;
    while (!nodeFs.existsSync(current)) {
      const parent = nodePath.dirname(current);
      if (parent === current) return null;
      suffix.unshift(nodePath.basename(current));
      current = parent;
    }

    try {
      const canonicalAncestor = nodeFs.realpathSync(current);
      return normalizePathForMatch(
        suffix.length > 0 ? nodePath.resolve(canonicalAncestor, ...suffix) : canonicalAncestor,
      );
    } catch {
      return null;
    }
  }
}

function isCanonicalPathWithinRoot(canonicalPath: string, canonicalRoot: string): boolean {
  if (canonicalRoot === '/') return canonicalPath.startsWith('/');
  const normalizedRoot = canonicalRoot.replace(/\/$/, '');
  return canonicalPath === normalizedRoot || canonicalPath.startsWith(normalizedRoot + '/');
}

/** Cached canonical cwd — process.cwd() never changes during a session. */
let _cachedCanonicalCwd: string | null | undefined;
function getCachedCanonicalCwd(): string | null {
  if (_cachedCanonicalCwd === undefined) {
    _cachedCanonicalCwd = canonicalizePathForCheck(process.cwd());
  }
  return _cachedCanonicalCwd;
}

function buildPathMatchCandidates(filePath: string, worktreeRoot?: string): string[] {
  const candidates = new Set<string>();
  const addCandidate = (candidate: string) => {
    const normalized = normalizePathForMatch(candidate);
    if (normalized.length > 0) {
      candidates.add(normalized);
    }
  };

  addCandidate(filePath);

  const canonicalFile = canonicalizePathForCheck(filePath);
  if (canonicalFile) {
    addCandidate(canonicalFile);

    const canonicalCwd = getCachedCanonicalCwd();
    if (canonicalCwd && isCanonicalPathWithinRoot(canonicalFile, canonicalCwd)) {
      addCandidate(nodePath.relative(canonicalCwd, canonicalFile));
    }
  }

  if (worktreeRoot) {
    const canonicalRoot = canonicalizePathForCheck(worktreeRoot);
    if (canonicalFile && canonicalRoot && isCanonicalPathWithinRoot(canonicalFile, canonicalRoot)) {
      addCandidate(nodePath.relative(canonicalRoot, canonicalFile));
    }
  }

  return [...candidates];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScopePolicy {
  allowed_paths: string[];
  denied_paths: string[];
  denied_patterns: RegExp[];
  max_files: number;
  max_lines: number;
  plan_required: boolean;
  /** When set, file writes are only allowed inside this worktree directory */
  worktree_root?: string;
  /** Adaptive risk assessment when learnings are provided */
  risk_assessment?: AdaptiveRiskAssessment;
}

// ---------------------------------------------------------------------------
// Derive scope policy from ticket + config
// ---------------------------------------------------------------------------

export interface DeriveScopeInput {
  allowedPaths: string[];
  category: string;
  maxLinesPerTicket: number;
  /** When set, restricts file writes to this worktree directory */
  worktreeRoot?: string;
  /** Cross-run learnings for adaptive trust (optional, backward compatible) */
  learnings?: Learning[];
}

export function deriveScopePolicy(input: DeriveScopeInput): ScopePolicy {
  let maxFiles = 10;
  let maxLines = input.category === 'test' ? 1000 : input.maxLinesPerTicket;
  let planRequired = input.category !== 'docs';
  let riskAssessment: AdaptiveRiskAssessment | undefined;

  // Adaptive trust: adjust constraints based on failure history in learnings
  if (input.learnings && input.learnings.length > 0) {
    riskAssessment = assessAdaptiveRisk(input.learnings, input.allowedPaths);

    switch (riskAssessment.level) {
      case 'low':
        maxFiles = 15;
        maxLines = Math.round(maxLines * 1.5);
        break;
      case 'normal':
        // No change — defaults
        break;
      case 'elevated':
        maxFiles = 7;
        planRequired = true;
        break;
      case 'high':
        maxFiles = 5;
        maxLines = Math.round(maxLines * 0.5);
        planRequired = true;
        break;
    }
  }

  const policy: ScopePolicy = {
    allowed_paths: input.allowedPaths,
    denied_paths: ALWAYS_DENIED,
    denied_patterns: FILE_DENY_PATTERNS,
    max_files: maxFiles,
    max_lines: maxLines,
    plan_required: planRequired,
    worktree_root: input.worktreeRoot,
    risk_assessment: riskAssessment,
  };
  return policy;
}

// ---------------------------------------------------------------------------
// Validate a plan against scope policy
// ---------------------------------------------------------------------------

export interface PlanFile {
  path: string;
  action: string;
  reason: string;
}

export interface PlanValidationResult {
  valid: boolean;
  reason: string | null;
  /** All violations found (empty when valid). Joined into `reason` for backward compat. */
  violations: string[];
}

export function validatePlanScope(
  files: PlanFile[],
  estimatedLines: number,
  riskLevel: string,
  policy: ScopePolicy,
): PlanValidationResult {
  const violations: string[] = [];

  // 1. Must have files
  if (!files || files.length === 0) {
    return { valid: false, reason: 'Plan must include at least one file to touch', violations: ['Plan must include at least one file to touch'] };
  }

  // 2. Check estimated lines
  if (estimatedLines > policy.max_lines) {
    violations.push(`Estimated lines (${estimatedLines}) exceeds max (${policy.max_lines})`);
  }

  // 3. Check max files
  if (files.length > policy.max_files) {
    violations.push(`Plan touches ${files.length} files, max allowed is ${policy.max_files}`);
  }

  // 4. Valid risk level
  if (!riskLevel || !['low', 'medium', 'high'].includes(riskLevel)) {
    violations.push('Plan must specify risk_level: low, medium, or high');
  }

  // 5. Check each file against denied paths
  for (const f of files) {
    for (const deniedGlob of policy.denied_paths) {
      if (minimatch(f.path, deniedGlob, { dot: true })) {
        violations.push(`Plan touches denied path: ${f.path} (matches ${deniedGlob})`);
      }
    }
  }

  // 6. Check each file against denied patterns
  for (const f of files) {
    for (const pattern of policy.denied_patterns) {
      if (pattern.test(f.path)) {
        violations.push(`Plan touches sensitive file: ${f.path}`);
      }
    }
  }

  // 7. Check each file is within allowed_paths (if any specified)
  if (policy.allowed_paths.length > 0) {
    for (const f of files) {
      const isAllowed = policy.allowed_paths.some(allowed =>
        matchesAllowedPath(f.path, allowed),
      );
      if (!isAllowed) {
        violations.push(`File ${f.path} is outside allowed paths: ${policy.allowed_paths.join(', ')}`);
      }
    }
  }

  if (violations.length > 0) {
    return { valid: false, reason: violations.join('; '), violations };
  }
  return { valid: true, reason: null, violations: [] };
}

// ---------------------------------------------------------------------------
// Worktree isolation check
// ---------------------------------------------------------------------------

/**
 * Check if a file path is inside a worktree directory.
 * Resolves canonical paths before comparison to block traversal/symlink escapes.
 */
export function isFileInWorktree(filePath: string, worktreeRoot: string): boolean {
  const canonicalFile = canonicalizePathForCheck(filePath);
  const canonicalRoot = canonicalizePathForCheck(worktreeRoot);
  if (!canonicalFile || !canonicalRoot) return false;
  return isCanonicalPathWithinRoot(canonicalFile, canonicalRoot);
}

// ---------------------------------------------------------------------------
// Check a single file path (used by PreToolUse hook)
// ---------------------------------------------------------------------------

export function isFileAllowed(filePath: string, policy: ScopePolicy): boolean {
  // Worktree enforcement: if set, reject files outside the worktree
  if (policy.worktree_root) {
    if (!isFileInWorktree(filePath, policy.worktree_root)) {
      return false;
    }
  }

  const pathCandidates = buildPathMatchCandidates(filePath, policy.worktree_root);

  // Check denied paths
  for (const deniedGlob of policy.denied_paths) {
    if (pathCandidates.some(candidate => minimatch(candidate, deniedGlob, { dot: true }))) {
      return false;
    }
  }

  // Check denied patterns
  for (const pattern of policy.denied_patterns) {
    if (pathCandidates.some(candidate => pattern.test(candidate))) {
      return false;
    }
  }

  // Check allowed paths (empty = everything allowed)
  if (policy.allowed_paths.length > 0) {
    return policy.allowed_paths.some(allowed =>
      pathCandidates.some(candidate => matchesAllowedPath(candidate, allowed)),
    );
  }

  return true;
}

// containsCredentials is re-exported from core above

// ---------------------------------------------------------------------------
// Enforce category file-type restrictions
// ---------------------------------------------------------------------------

/**
 * Check if a file path is allowed by the category tool policy.
 * Returns true if no category policy exists (= everything allowed).
 * For docs: only *.md, *.mdx, *.txt, *.rst files.
 * For test: only *.test.*, *.spec.*, __tests__/** files.
 * Security has no file-type restrictions (only command restrictions).
 */
export function isCategoryFileAllowed(filePath: string, category: string | null): boolean {
  if (!category) return true;

  const CATEGORY_FILE_PATTERNS: Record<string, string[]> = {
    docs: ['*.md', '*.mdx', '*.txt', '*.rst', '**/*.md', '**/*.mdx', '**/*.txt', '**/*.rst'],
    test: [
      // JS/TS
      '*.test.*', '*.spec.*', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '__tests__/**',
      // Python
      'test_*', '**/test_*', '*_test.py', '**/*_test.py', '**/tests/**', 'tests/**', '**/conftest.py',
      // Go
      '*_test.go', '**/*_test.go',
      // Rust (tests/ dir)
      'tests/**', '**/tests/**',
      // Java/Kotlin
      '*Test.java', '**/*Test.java', '*Test.kt', '**/*Test.kt', '**/src/test/**',
      // Ruby
      '*_spec.rb', '**/*_spec.rb', '**/spec/**',
      // Elixir
      '*_test.exs', '**/*_test.exs',
      // Swift
      '*Tests.swift', '**/*Tests.swift',
      // PHP
      '*Test.php', '**/*Test.php',
    ],
  };

  const patterns = CATEGORY_FILE_PATTERNS[category];
  if (!patterns) return true; // no restrictions for this category (e.g. security, fix, refactor)

  return patterns.some(glob => minimatch(filePath, glob, { dot: true }));
}

// ---------------------------------------------------------------------------
// Serialize policy for MCP tool response (RegExp → string)
// ---------------------------------------------------------------------------

export function serializeScopePolicy(policy: ScopePolicy): Record<string, unknown> {
  const result: Record<string, unknown> = {
    allowed_paths: policy.allowed_paths,
    denied_paths: policy.denied_paths,
    denied_patterns: policy.denied_patterns.map(r => r.source),
    max_files: policy.max_files,
    max_lines: policy.max_lines,
    plan_required: policy.plan_required,
  };
  if (policy.worktree_root) {
    result.worktree_root = policy.worktree_root;
  }
  if (policy.risk_assessment) {
    result.risk_assessment = policy.risk_assessment;
  }
  return result;
}
