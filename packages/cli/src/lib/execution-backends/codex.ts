/**
 * Codex CLI execution backend
 *
 * Default: `--sandbox workspace-write` (safe unattended mode).
 * Optional: `unsafeBypassSandbox` enables `--dangerously-bypass-approvals-and-sandbox`
 * for use inside externally hardened/isolated runners only.
 */

import { formatElapsed, runBackendHarness } from './process-runner.js';
import type { BackendRunOptions, ExecutionResult, ExecutionBackend } from './types.js';

/** Parse Codex JSONL output to extract meaningful progress info */
function parseCodexEvent(line: string): { phase?: string; detail?: string; message?: string } | null {
  try {
    const event = JSON.parse(line);

    // Codex streaming format: item.started, item.completed events
    if (event.type === 'item.completed' && event.item) {
      const item = event.item;

      // Reasoning/thinking events - show the full thought
      if (item.type === 'reasoning' && item.text) {
        // Clean up markdown formatting
        const text = item.text.replace(/^\*\*/, '').replace(/\*\*$/, '').trim();
        return { phase: 'Thinking', message: text };
      }

      // Command execution events
      if (item.type === 'command_execution' && item.command) {
        // Extract just the actual command, not the shell wrapper
        let cmd = item.command;
        // Remove /bin/bash -lc wrapper if present
        const match = cmd.match(/\/bin\/(?:ba)?sh\s+-[a-z]*c\s+'(.+)'$/);
        if (match) cmd = match[1];
        // Truncate very long commands
        if (cmd.length > 80) cmd = cmd.slice(0, 77) + '...';
        return { phase: 'Running', message: cmd };
      }

      // File operations
      if (item.type === 'file_read' || item.type === 'read_file') {
        return { phase: 'Reading', message: item.path || item.file };
      }
      if (item.type === 'file_write' || item.type === 'write_file' || item.type === 'file_edit') {
        return { phase: 'Writing', message: item.path || item.file };
      }
    }

    // Item started events - show what's beginning
    if (event.type === 'item.started' && event.item) {
      const item = event.item;
      if (item.type === 'command_execution') {
        return { phase: 'Starting command' };
      }
    }

    // Legacy format support
    if (event.type === 'function_call' || event.type === 'tool_use') {
      const name = event.name || event.function?.name || '';
      if (name.includes('read') || name.includes('Read')) return { phase: 'Reading', detail: name };
      if (name.includes('write') || name.includes('Write') || name.includes('edit') || name.includes('Edit')) return { phase: 'Writing', detail: name };
      if (name.includes('bash') || name.includes('Bash') || name.includes('exec')) return { phase: 'Running command', detail: name };
      if (name.includes('grep') || name.includes('Grep') || name.includes('search')) return { phase: 'Searching', detail: name };
      return { phase: 'Tool', detail: name };
    }

    if (event.type === 'done' || event.type === 'complete') {
      return { phase: 'Completing' };
    }
  } catch {
    // Not JSON, ignore
  }
  return null;
}

export class CodexExecutionBackend implements ExecutionBackend {
  readonly name = 'codex';
  private apiKey?: string;
  private model: string;
  private unsafeBypassSandbox: boolean;

  constructor(opts?: { apiKey?: string; model?: string; unsafeBypassSandbox?: boolean }) {
    this.apiKey = opts?.apiKey;
    this.model = opts?.model ?? 'gpt-5.3-codex';
    this.unsafeBypassSandbox = opts?.unsafeBypassSandbox ?? false;
  }

  async run(opts: BackendRunOptions): Promise<ExecutionResult> {
    const { worktreePath, prompt, timeoutMs, onProgress, onRawOutput } = opts;

    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = mkdtempSync(join(tmpdir(), 'promptwheel-codex-exec-'));
    const outPath = join(tmpDir, 'output.md');

    try {
      const args = ['exec', '--json', '--output-last-message', outPath];

      if (this.unsafeBypassSandbox) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else {
        args.push('--sandbox', 'workspace-write');
      }

      args.push('--model', this.model);
      args.push('--cd', worktreePath);
      args.push('-');

      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (this.apiKey) {
        env.OPENAI_API_KEY = this.apiKey;
      }

      let lastPhase = 'Starting';
      let lineBuffer = '';

      const result = await runBackendHarness({
        timeoutMs,
        exitErrorPrefix: 'codex',
        onProgress,
        getProgressPhase: () => lastPhase,
        process: {
          command: 'codex',
          args,
          cwd: worktreePath,
          env,
          stdin: prompt,
          onStdoutChunk: (text, { elapsedMs }) => {
            // Parse JSONL lines for progress info
            lineBuffer += text;
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
              if (!line.trim()) continue;
              const parsed = parseCodexEvent(line);
              if (parsed) {
                const elapsed = formatElapsed(elapsedMs);

                if (parsed.message) {
                  // Show full message for reasoning/commands
                  lastPhase = parsed.phase || lastPhase;
                  onProgress(`${parsed.phase}: ${parsed.message} (${elapsed})`);
                  onRawOutput?.(`[${parsed.phase}] ${parsed.message}\n`);
                } else if (parsed.phase) {
                  // Just phase update
                  lastPhase = parsed.phase;
                  const detail = parsed.detail ? `: ${parsed.detail}` : '';
                  onProgress(`${lastPhase}${detail} (${elapsed})`);
                  onRawOutput?.(`[${lastPhase}]${detail}\n`);
                }
              } else {
                // Unparsed lines: emit raw for TUI
                onRawOutput?.(line + '\n');
              }
            }
            // Don't show raw JSONL even in verbose mode - it's not useful
          },
          onStderrChunk: (text) => {
            onRawOutput?.(`[stderr] ${text}`);
          },
        },
        postProcess: (result) => {
          // Keep timeout behavior: return raw telemetry stdout when command times out.
          if (result.timedOut) {
            return {};
          }

          // Prefer --output-last-message file over stdout (stdout is JSONL telemetry)
          let output = result.stdout;
          try {
            output = readFileSync(outPath, 'utf-8');
          } catch {
            // Fall back to stdout if file wasn't written
          }

          return { stdout: output };
        },
      });

      return result;
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
