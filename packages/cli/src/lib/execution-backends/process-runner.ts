import { spawn } from 'node:child_process';
import { createProcessLifecycleController } from './types.js';
import type {
  BackendHarnessOptions,
  ClaudeResult,
  BackendResultOverrides,
  ProcessRunnerChunkContext,
  ProcessRunnerOptions,
  ProcessRunnerResult,
} from './types.js';

const DEFAULT_PROGRESS_TICK_MS = 3000;
const DEFAULT_TIMEOUT_GRACE_MS = 5000;

/** Format elapsed time as human-readable string */
export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainingSecs = secs % 60;
  return `${mins}m${remainingSecs}s`;
}

export function formatProgressTick(phase: string, elapsedMs: number): string {
  return `${phase}... (${formatElapsed(elapsedMs)})`;
}

export async function runProcess(opts: ProcessRunnerOptions): Promise<ProcessRunnerResult> {
  const startTime = Date.now();

  return await new Promise((resolve) => {
    const proc = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let progressInterval: NodeJS.Timeout | null = null;
    const lifecycle = createProcessLifecycleController({
      child: proc,
      timeoutMs: opts.timeoutMs,
      killGraceMs: opts.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS,
    });

    const makeCtx = (): ProcessRunnerChunkContext => ({
      elapsedMs: Date.now() - startTime,
    });

    const cleanup = () => {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    };

    const settle = (result: ProcessRunnerResult) => {
      lifecycle.settleOnce(() => {
        cleanup();
        resolve(result);
      });
    };

    if (opts.getProgressMessage && opts.onProgress) {
      progressInterval = setInterval(() => {
        const msg = opts.getProgressMessage?.(makeCtx());
        if (msg) {
          opts.onProgress?.(msg);
        }
      }, opts.progressTickMs ?? DEFAULT_PROGRESS_TICK_MS);
    }

    if (opts.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      opts.onStdoutChunk?.(chunk, makeCtx());
    });

    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      opts.onStderrChunk?.(chunk, makeCtx());
    });

    proc.on('close', (code: number | null) => {
      settle({
        stdout,
        stderr,
        exitCode: code,
        timedOut: lifecycle.timedOut,
        durationMs: Date.now() - startTime,
      });
    });

    proc.on('error', (error: Error) => {
      settle({
        stdout,
        stderr,
        exitCode: null,
        timedOut: lifecycle.timedOut,
        durationMs: Date.now() - startTime,
        error,
      });
    });
  });
}

export async function runBackendHarness(opts: BackendHarnessOptions): Promise<ClaudeResult> {
  const result = await runProcess({
    ...opts.process,
    timeoutMs: opts.timeoutMs,
    onProgress: opts.onProgress,
    getProgressMessage: opts.getProgressPhase
      ? ({ elapsedMs }) => formatProgressTick(opts.getProgressPhase!() || 'Running', elapsedMs)
      : undefined,
  });

  const overrides: BackendResultOverrides = opts.postProcess
    ? await opts.postProcess(result)
    : {};

  const stdout = overrides.stdout ?? result.stdout;
  const stderr = overrides.stderr ?? result.stderr;
  const exitCode = overrides.exitCode ?? result.exitCode;

  const traceData = {
    ...(overrides.traceEvents !== undefined ? { traceEvents: overrides.traceEvents } : {}),
    ...(overrides.traceTimestamps !== undefined ? { traceTimestamps: overrides.traceTimestamps } : {}),
  };

  if (result.timedOut) {
    return {
      success: false,
      error: `Timed out after ${opts.timeoutMs}ms`,
      stdout,
      stderr,
      exitCode,
      timedOut: true,
      durationMs: result.durationMs,
      ...traceData,
    };
  }

  if (result.error) {
    return {
      success: false,
      error: result.error.message,
      stdout,
      stderr,
      exitCode: null,
      timedOut: false,
      durationMs: result.durationMs,
      ...traceData,
    };
  }

  if (exitCode !== 0) {
    return {
      success: false,
      error: `${opts.exitErrorPrefix} exited with code ${exitCode}: ${stderr.slice(0, 200)}`,
      stdout,
      stderr,
      exitCode,
      timedOut: false,
      durationMs: result.durationMs,
      ...traceData,
    };
  }

  return {
    success: true,
    stdout,
    stderr,
    exitCode,
    timedOut: false,
    durationMs: result.durationMs,
    ...traceData,
  };
}
