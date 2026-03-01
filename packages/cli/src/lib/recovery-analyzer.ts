/**
 * Recovery analyzer — diagnose failed tickets and suggest recovery strategies.
 *
 * When a ticket executor fails, this module analyzes the failure pattern
 * and recommends a recovery action (retry with hint, narrow scope, skip).
 */

import type { RunTicketResult } from './solo-ticket-types.js';
import type { TicketProposal } from '@promptwheel/core/scout';
import { classifyFailure } from './failure-classifier.js';

export type RecoveryAction =
  | { action: 'retry_with_hint'; hint: string }
  | { action: 'narrow_scope'; files: string[] }
  | { action: 'skip'; reason: string };

/**
 * Analyze a ticket failure and recommend a recovery strategy.
 *
 * Logic:
 * - Spindle abort (spinning/oscillation) -> retry with hint about the pattern
 * - Scope violation -> narrow scope to only the files that were being edited
 * - QA failure -> retry with hint about which test failed
 * - Timeout -> skip (likely too complex)
 * - Agent error with identifiable pattern -> retry with diagnostic hint
 * - Unknown/irrecoverable -> skip
 */
export function analyzeFailure(
  result: RunTicketResult,
  proposal: TicketProposal,
): RecoveryAction {
  const failureReason = result.failureReason ?? 'agent_error';
  const error = result.error ?? '';
  // classifyFailure is called for side-effect-free classification; result unused directly
  // but keeps the analysis pipeline consistent with failure-classifier patterns
  classifyFailure(failureReason, error);

  // Timeout — too complex, don't retry
  if (failureReason === 'timeout') {
    return { action: 'skip', reason: 'Ticket timed out — likely too complex for a single execution' };
  }

  // Spindle abort — the agent was spinning/oscillating
  if (failureReason === 'spindle_abort' && result.spindle) {
    const trigger = result.spindle.trigger;
    if (trigger === 'oscillation' || trigger === 'spinning') {
      return {
        action: 'retry_with_hint',
        hint: `Previous attempt failed due to ${trigger}. ` +
          `The agent was repeating similar actions without progress. ` +
          `Take a different approach: read relevant code first, plan your changes, then make them in one pass. ` +
          `Avoid trial-and-error loops.`,
      };
    }
    if (trigger === 'qa_ping_pong') {
      return {
        action: 'retry_with_hint',
        hint: `Previous attempt failed because the agent kept fixing one test only to break another. ` +
          `Read all related test files first, understand the full test suite, then make changes that satisfy ALL tests simultaneously.`,
      };
    }
    // Other spindle triggers — likely irrecoverable
    return { action: 'skip', reason: `Spindle abort (${trigger}) — agent unable to make progress` };
  }

  // Scope violation — narrow to files the proposal actually targets
  if (failureReason === 'scope_violation') {
    const targetFiles = proposal.files?.filter(f => !f.includes('*')) ?? [];
    if (targetFiles.length > 0 && targetFiles.length < (proposal.files?.length ?? 0)) {
      return {
        action: 'narrow_scope',
        files: targetFiles,
      };
    }
    return { action: 'skip', reason: 'Scope violation with no narrower scope available' };
  }

  // QA failure — retry with test-specific hint
  if (failureReason === 'qa_failed') {
    const testMatch = error.match(/(?:FAIL|FAILED|Error)[:\s]+(.{1,200})/i);
    const testHint = testMatch?.[1]?.trim() ?? 'tests failed';
    return {
      action: 'retry_with_hint',
      hint: `Previous attempt failed QA: ${testHint}. ` +
        `Before making changes, run the existing tests to understand what passes. ` +
        `Ensure your changes don't break any existing tests.`,
    };
  }

  // Git/PR errors — usually transient or environmental, skip
  if (failureReason === 'git_error' || failureReason === 'pr_error') {
    return { action: 'skip', reason: `${failureReason}: ${error.slice(0, 100)}` };
  }

  // Agent error — try to extract useful diagnostic info
  if (failureReason === 'agent_error') {
    // Check for common patterns
    if (error.includes('permission') || error.includes('Permission')) {
      return {
        action: 'retry_with_hint',
        hint: `Previous attempt failed with a permission error. ` +
          `Only modify files within the allowed paths. Do not attempt to install packages or modify system files.`,
      };
    }
    if (error.includes('not found') || error.includes('No such file')) {
      return {
        action: 'retry_with_hint',
        hint: `Previous attempt failed because a file or command was not found. ` +
          `Verify file paths exist before editing. Use search/glob to find the correct paths.`,
      };
    }
    // Generic agent error with some error text — retry with the error as context
    if (error.length > 10) {
      return {
        action: 'retry_with_hint',
        hint: `Previous attempt failed: ${error.slice(0, 300)}. ` +
          `Take a different approach to avoid this error.`,
      };
    }
  }

  // Fallback — skip
  return { action: 'skip', reason: `Unrecoverable failure: ${failureReason}` };
}
