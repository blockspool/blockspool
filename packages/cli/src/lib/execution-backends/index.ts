/**
 * Execution backends registry
 *
 * Each backend spawns a different LLM CLI to implement tickets in worktrees.
 */

export type { ExecutionResult, ExecutionBackend } from './types.js';
export { ClaudeExecutionBackend, runClaudeCli } from './claude.js';
export { CodexExecutionBackend } from './codex.js';
export { KimiExecutionBackend } from './kimi.js';
