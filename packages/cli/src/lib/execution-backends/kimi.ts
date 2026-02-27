/**
 * Kimi CLI execution backend
 *
 * Spawns `kimi --print --model <model>` with prompt on stdin.
 * Output is on stdout. No --output-last-message or --output-schema.
 */

import { runBackendHarness } from './process-runner.js';
import type { BackendRunOptions, ExecutionResult, ExecutionBackend } from './types.js';

export class KimiExecutionBackend implements ExecutionBackend {
  readonly name = 'kimi';
  private apiKey?: string;
  private model: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey;
    this.model = opts?.model ?? 'kimi-k2.5';
  }

  async run(opts: BackendRunOptions): Promise<ExecutionResult> {
    const { worktreePath, prompt, timeoutMs, verbose, onProgress, onRawOutput } = opts;
    const args = ['--print', '--model', this.model];

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (this.apiKey) {
      env.MOONSHOT_API_KEY = this.apiKey;
    }

    return runBackendHarness({
      timeoutMs,
      exitErrorPrefix: 'kimi',
      onProgress,
      getProgressPhase: () => 'Running',
      process: {
        command: 'kimi',
        args,
        cwd: worktreePath,
        env,
        stdin: prompt,
        onStdoutChunk: (text) => {
          onRawOutput?.(text);
          if (verbose) {
            onProgress(text.trim().slice(0, 100));
          }
        },
        onStderrChunk: (text) => {
          onRawOutput?.(`[stderr] ${text}`);
        },
      },
    });
  }
}
