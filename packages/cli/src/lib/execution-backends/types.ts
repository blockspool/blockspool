/**
 * Execution backend types
 */

import type { ChildProcess } from 'node:child_process';
import type { StreamJsonEvent } from '@promptwheel/core/trace/shared';

export interface BackendRunOptions {
  worktreePath: string;
  prompt: string;
  timeoutMs: number;
  verbose: boolean;
  onProgress: (msg: string) => void;
  /** Stream raw stdout/stderr chunks for live TUI display */
  onRawOutput?: (chunk: string) => void;
  /** Override the model used for this execution (e.g. 'haiku', 'sonnet', 'opus') */
  model?: string;
}

/**
 * Execution result with full details for artifact storage
 */
export interface ClaudeResult {
  success: boolean;
  error?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Parsed JSONL events when using --output-format stream-json (undefined if text mode) */
  traceEvents?: StreamJsonEvent[];
  /** Per-event timestamps for liveness computation */
  traceTimestamps?: number[];
}

/**
 * Pluggable execution backend interface
 */
export interface ExecutionBackend {
  /** Human-readable name for logging */
  readonly name: string;
  /** Run a prompt against a worktree and return the result */
  run(opts: BackendRunOptions): Promise<ClaudeResult>;
}

export interface ProcessRunnerChunkContext {
  elapsedMs: number;
}

export interface ProcessRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: Error;
}

export interface ProcessRunnerOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  timeoutGraceMs?: number;
  progressTickMs?: number;
  onProgress?: (msg: string) => void;
  getProgressMessage?: (ctx: ProcessRunnerChunkContext) => string | null | undefined;
  onStdoutChunk?: (chunk: string, ctx: ProcessRunnerChunkContext) => void;
  onStderrChunk?: (chunk: string, ctx: ProcessRunnerChunkContext) => void;
}

export interface BackendResultOverrides {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  traceEvents?: StreamJsonEvent[];
  traceTimestamps?: number[];
}

export interface BackendHarnessOptions {
  timeoutMs: number;
  exitErrorPrefix: string;
  process: Omit<ProcessRunnerOptions, 'timeoutMs' | 'onProgress' | 'getProgressMessage'>;
  onProgress?: (msg: string) => void;
  getProgressPhase?: () => string;
  postProcess?: (result: ProcessRunnerResult) => BackendResultOverrides | Promise<BackendResultOverrides>;
}

export type ProcessLifecycleTerminationReason = 'timeout' | 'canceled' | 'error' | 'manual';

export interface ProcessLifecycleController {
  readonly timedOut: boolean;
  settleOnce(onSettle: () => void): boolean;
  terminate(reason?: ProcessLifecycleTerminationReason): void;
  cleanup(): void;
}

export interface ProcessLifecycleOptions {
  child: ChildProcess;
  timeoutMs?: number;
  killGraceMs: number;
  onTimeout?: () => void;
}

/**
 * Shared child-process lifecycle policy:
 * - timeout -> SIGTERM -> SIGKILL escalation
 * - settle-once guarantee with timer cleanup
 */
export function createProcessLifecycleController(
  opts: ProcessLifecycleOptions
): ProcessLifecycleController {
  let timeoutTimer: NodeJS.Timeout | null = null;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let timedOut = false;
  let terminated = false;
  let settled = false;

  const cleanup = (): void => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    const childExited = opts.child.exitCode !== null || opts.child.signalCode !== null;
    if (forceKillTimer && (!terminated || childExited)) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const terminate = (_reason: ProcessLifecycleTerminationReason = 'manual'): void => {
    if (terminated) return;
    terminated = true;

    try {
      opts.child.kill('SIGTERM');
    } catch {
      // ignore
    }

    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      const childExited = opts.child.exitCode !== null || opts.child.signalCode !== null;
      if (childExited) return;
      try {
        opts.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, opts.killGraceMs);
  };

  if ((opts.timeoutMs ?? 0) > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      opts.onTimeout?.();
      terminate('timeout');
    }, opts.timeoutMs);
  }

  const settleOnce = (onSettle: () => void): boolean => {
    if (settled) return false;
    settled = true;
    cleanup();
    onSettle();
    return true;
  };

  return {
    get timedOut() {
      return timedOut;
    },
    settleOnce,
    terminate,
    cleanup,
  };
}
