/**
 * Scout runner - Executes Claude Code CLI for analysis
 */

import { spawn } from 'node:child_process';

export interface RunnerOptions {
  /** Prompt to send to Claude */
  prompt: string;
  /** Working directory */
  cwd: string;
  /** Timeout in ms */
  timeoutMs: number;
  /** Model to use */
  model?: 'haiku' | 'sonnet' | 'opus';
  /** Cancellation signal */
  signal?: AbortSignal;
}

export interface RunnerResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Output from Claude */
  output: string;
  /** Error message if failed */
  error?: string;
  /** Duration in ms */
  durationMs: number;
}

/**
 * Run Claude Code CLI with a prompt
 */
export async function runClaude(options: RunnerOptions): Promise<RunnerResult> {
  const { prompt, cwd, timeoutMs, model = 'sonnet', signal } = options;
  const start = Date.now();

  return new Promise((resolve) => {
    // Check if already aborted
    if (signal?.aborted) {
      resolve({
        success: false,
        output: '',
        error: 'Aborted before start',
        durationMs: Date.now() - start,
      });
      return;
    }

    const args = [
      '-p', prompt,
      '--model', model,
      '--output-format', 'text',
      '--allowedTools', '',  // Disable tools - content provided in prompt
    ];

    const proc = spawn('claude', args, {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_NON_INTERACTIVE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Timeout handler
    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      // Grace period before SIGKILL
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeoutMs);

    // Abort signal handler
    const abortHandler = () => {
      killed = true;
      proc.kill('SIGTERM');
    };
    signal?.addEventListener('abort', abortHandler);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);

      const durationMs = Date.now() - start;

      if (killed) {
        resolve({
          success: false,
          output: stdout,
          error: signal?.aborted ? 'Aborted by signal' : 'Timeout exceeded',
          durationMs,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          output: stdout,
          error: stderr || `Process exited with code ${code}`,
          durationMs,
        });
        return;
      }

      resolve({
        success: true,
        output: stdout,
        durationMs,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);

      resolve({
        success: false,
        output: '',
        error: err.message,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
 * Parse JSON from Claude's output
 *
 * Handles common issues like markdown code blocks
 */
export function parseClaudeOutput<T>(output: string): T | null {
  // Try direct parse first
  try {
    return JSON.parse(output.trim());
  } catch {
    // Ignore and try other methods
  }

  // Try extracting from markdown code block
  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {
      // Ignore
    }
  }

  // Try finding JSON object/array in output
  const objectMatch = output.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // Ignore
    }
  }

  return null;
}
