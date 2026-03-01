/**
 * Claude Code CLI execution backend
 */

import { formatProgressTick, runBackendHarness } from './process-runner.js';
import type { BackendRunOptions, ClaudeResult, ExecutionBackend } from './types.js';
import {
  parseStreamJsonLine,
  isStreamJsonOutput,
  reconstructText,
  type StreamJsonEvent,
} from '@promptwheel/core/trace/shared';

/** Detect phase from Claude CLI output patterns */
function detectPhase(text: string): string | null {
  const lower = text.toLowerCase();
  // Tool usage patterns
  if (lower.includes('reading') || lower.includes('read file') || lower.includes('let me read')) return 'Reading files';
  if (lower.includes('writing') || lower.includes('write file') || lower.includes('let me write') || lower.includes('creating file')) return 'Writing files';
  if (lower.includes('editing') || lower.includes('edit file') || lower.includes('let me edit') || lower.includes('updating')) return 'Editing files';
  if (lower.includes('running') || lower.includes('execute') || lower.includes('bash') || lower.includes('npm ') || lower.includes('running command')) return 'Running command';
  if (lower.includes('searching') || lower.includes('grep') || lower.includes('looking for') || lower.includes('finding')) return 'Searching';
  if (lower.includes('analyzing') || lower.includes('examining') || lower.includes('reviewing')) return 'Analyzing';
  if (lower.includes('testing') || lower.includes('test')) return 'Testing';
  if (lower.includes('commit') || lower.includes('git')) return 'Git operations';
  return null;
}

export class ClaudeExecutionBackend implements ExecutionBackend {
  readonly name = 'claude';

  run(opts: BackendRunOptions): Promise<ClaudeResult> {
    return runClaude(opts);
  }
}

/**
 * Run Claude Code CLI
 */
export async function runClaude(opts: BackendRunOptions): Promise<ClaudeResult> {
  const { worktreePath, prompt, timeoutMs, verbose, onProgress, onRawOutput, model } = opts;

  // Gate: require ANTHROPIC_API_KEY for automated Claude Code usage
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Running Claude Code in automation requires ANTHROPIC_API_KEY.\n' +
      'Set the env var for API access, or use the PromptWheel plugin (/promptwheel:run) inside Claude Code.'
    );
  }

  let lastPhase = 'Starting';
  let isStreamJson: boolean | null = null; // detected from first line
  const traceEvents: StreamJsonEvent[] = [];
  const traceTimestamps: number[] = [];
  let lineBuf = '';

  return runBackendHarness({
    timeoutMs,
    exitErrorPrefix: 'Claude',
    onProgress,
    getProgressPhase: () => lastPhase,
    process: {
      command: 'claude',
      args: [
        '-p', '--dangerously-skip-permissions', '--output-format', 'stream-json',
        ...(model ? ['--model', model] : []),
      ],
      cwd: worktreePath,
      env: { ...process.env, CLAUDE_CODE_NON_INTERACTIVE: '1' },
      stdin: prompt,
      onStdoutChunk: (text, { elapsedMs }) => {
        onRawOutput?.(text);

        // Parse stream-json lines in real-time
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? ''; // keep incomplete last line

        for (const line of lines) {
          if (!line.trim()) continue;

          // Auto-detect on first line
          if (isStreamJson === null) {
            isStreamJson = isStreamJsonOutput(line);
          }

          if (isStreamJson) {
            const evt = parseStreamJsonLine(line);
            if (evt) {
              traceEvents.push(evt);
              traceTimestamps.push(Date.now());
            }
          }
        }

        // Detect phase: use stream-json tool names or fall back to text matching
        let phaseText = text;
        if (isStreamJson && traceEvents.length > 0) {
          phaseText = reconstructText(traceEvents.slice(-3));
        }
        const phase = detectPhase(phaseText);
        if (phase) {
          lastPhase = phase;
          onProgress(formatProgressTick(lastPhase, elapsedMs));
        }

        if (verbose) {
          onProgress(text.trim().slice(0, 100));
        }
      },
      onStderrChunk: (text) => {
        onRawOutput?.(`[stderr] ${text}`);
      },
    },
    postProcess: (result) => {
      // Process any remaining buffer
      if (lineBuf.trim() && isStreamJson) {
        const evt = parseStreamJsonLine(lineBuf);
        if (evt) {
          traceEvents.push(evt);
          traceTimestamps.push(Date.now());
        }
      }

      // Reconstruct plain text stdout for backward compat when using stream-json
      const plainStdout = isStreamJson && traceEvents.length > 0
        ? reconstructText(traceEvents)
        : result.stdout;

      if (isStreamJson && traceEvents.length > 0) {
        return { stdout: plainStdout, traceEvents, traceTimestamps };
      }

      return { stdout: plainStdout };
    },
  });
}
