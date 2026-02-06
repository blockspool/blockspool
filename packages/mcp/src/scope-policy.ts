/**
 * Scope Policy — derives and enforces file-level constraints for tickets.
 *
 * Used by the plan validator and PreToolUse hook to ensure
 * agents only touch files they're allowed to.
 *
 * Shared constants (ALWAYS_DENIED, CREDENTIAL_PATTERNS, FILE_DENY_PATTERNS)
 * and pure algorithms live in @blockspool/core/scope/shared.
 * This file adds MCP-specific policy derivation and minimatch-based validation.
 */

import { minimatch } from 'minimatch';
import {
  ALWAYS_DENIED,
  CREDENTIAL_PATTERNS,
  FILE_DENY_PATTERNS,
  detectCredentialInContent,
} from '@blockspool/core/scope/shared';

// Re-export for existing consumers
export { detectCredentialInContent as containsCredentials } from '@blockspool/core/scope/shared';

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
}

// ---------------------------------------------------------------------------
// Derive scope policy from ticket + config
// ---------------------------------------------------------------------------

export interface DeriveScopeInput {
  allowedPaths: string[];
  category: string;
  maxLinesPerTicket: number;
}

export function deriveScopePolicy(input: DeriveScopeInput): ScopePolicy {
  return {
    allowed_paths: input.allowedPaths,
    denied_paths: ALWAYS_DENIED,
    denied_patterns: FILE_DENY_PATTERNS,
    max_files: 10,
    max_lines: input.category === 'test' ? 1000 : input.maxLinesPerTicket,
    plan_required: input.category !== 'docs',
  };
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
}

export function validatePlanScope(
  files: PlanFile[],
  estimatedLines: number,
  riskLevel: string,
  policy: ScopePolicy,
): PlanValidationResult {
  // 1. Must have files
  if (!files || files.length === 0) {
    return { valid: false, reason: 'Plan must include at least one file to touch' };
  }

  // 2. Check estimated lines
  if (estimatedLines > policy.max_lines) {
    return {
      valid: false,
      reason: `Estimated lines (${estimatedLines}) exceeds max (${policy.max_lines})`,
    };
  }

  // 3. Check max files
  if (files.length > policy.max_files) {
    return {
      valid: false,
      reason: `Plan touches ${files.length} files, max allowed is ${policy.max_files}`,
    };
  }

  // 4. Valid risk level
  if (!riskLevel || !['low', 'medium', 'high'].includes(riskLevel)) {
    return { valid: false, reason: 'Plan must specify risk_level: low, medium, or high' };
  }

  // 5. Check each file against denied paths
  for (const f of files) {
    for (const deniedGlob of policy.denied_paths) {
      if (minimatch(f.path, deniedGlob, { dot: true })) {
        return { valid: false, reason: `Plan touches denied path: ${f.path} (matches ${deniedGlob})` };
      }
    }
  }

  // 6. Check each file against denied patterns
  for (const f of files) {
    for (const pattern of policy.denied_patterns) {
      if (pattern.test(f.path)) {
        return { valid: false, reason: `Plan touches sensitive file: ${f.path}` };
      }
    }
  }

  // 7. Check each file is within allowed_paths (if any specified)
  if (policy.allowed_paths.length > 0) {
    for (const f of files) {
      const isAllowed = policy.allowed_paths.some(glob =>
        minimatch(f.path, glob, { dot: true }),
      );
      if (!isAllowed) {
        return {
          valid: false,
          reason: `File ${f.path} is outside allowed paths: ${policy.allowed_paths.join(', ')}`,
        };
      }
    }
  }

  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// Check a single file path (used by PreToolUse hook)
// ---------------------------------------------------------------------------

export function isFileAllowed(filePath: string, policy: ScopePolicy): boolean {
  // Check denied paths
  for (const deniedGlob of policy.denied_paths) {
    if (minimatch(filePath, deniedGlob, { dot: true })) {
      return false;
    }
  }

  // Check denied patterns
  for (const pattern of policy.denied_patterns) {
    if (pattern.test(filePath)) {
      return false;
    }
  }

  // Check allowed paths (empty = everything allowed)
  if (policy.allowed_paths.length > 0) {
    return policy.allowed_paths.some(glob =>
      minimatch(filePath, glob, { dot: true }),
    );
  }

  return true;
}

// containsCredentials is re-exported from core above

// ---------------------------------------------------------------------------
// Serialize policy for MCP tool response (RegExp → string)
// ---------------------------------------------------------------------------

export function serializeScopePolicy(policy: ScopePolicy): Record<string, unknown> {
  return {
    allowed_paths: policy.allowed_paths,
    denied_paths: policy.denied_paths,
    denied_patterns: policy.denied_patterns.map(r => r.source),
    max_files: policy.max_files,
    max_lines: policy.max_lines,
    plan_required: policy.plan_required,
  };
}
