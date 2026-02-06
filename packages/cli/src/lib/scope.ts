/**
 * Scope enforcement utilities
 *
 * Pure algorithms live in @blockspool/core/scope/shared.
 * This file re-exports them for CLI consumers.
 */

export {
  normalizePath,
  detectHallucinatedPath,
  checkScopeViolations,
  matchesPattern,
  analyzeViolationsForExpansion,
  parseChangedFiles,
  type ScopeViolation,
  type ScopeExpansionResult,
} from '@blockspool/core/scope/shared';
