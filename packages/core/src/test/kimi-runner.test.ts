import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KimiScoutBackend } from '../scout/kimi-runner.js';

vi.mock('node:child_process');

describe('KimiScoutBackend', () => {
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const childProcess = await import('node:child_process');
    mockSpawn = vi.mocked(childProcess.spawn);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('spawns kimi with required args and default model', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild as any);

    const backend = new KimiScoutBackend();
    const promise = backend.run({
      prompt: 'Inspect the codebase',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
    });

    mockChild.stdout.emit('data', 'stream-output');
    mockChild.emit('close', 0);

    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.output).toBe('stream-output');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toEqual([
      '--print',
      '-p',
      'Inspect the codebase',
      '--model',
      'kimi-k2.5',
      '--output-format',
      'stream-json',
    ]);

    const spawnOptions = mockSpawn.mock.calls[0][2] as { cwd?: string; stdio?: string[] };
    expect(spawnOptions.cwd).toBe('/tmp/repo');
    expect(spawnOptions.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('uses per-run model override when provided', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild as any);

    const backend = new KimiScoutBackend({ model: 'kimi-from-constructor' });
    const promise = backend.run({
      prompt: 'Test model override',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
      model: 'kimi-override',
    });

    mockChild.emit('close', 0);
    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toEqual([
      '--print',
      '-p',
      'Test model override',
      '--model',
      'kimi-override',
      '--output-format',
      'stream-json',
    ]);
  });

  it('injects MOONSHOT_API_KEY when backend api key is configured', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild as any);

    const backend = new KimiScoutBackend({ apiKey: 'moonshot-test-key' });
    const promise = backend.run({
      prompt: 'Check env wiring',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
    });

    mockChild.emit('close', 0);
    await promise;

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env?: Record<string, string | undefined> };
    expect(spawnOptions.env?.MOONSHOT_API_KEY).toBe('moonshot-test-key');
  });

  it('returns failure with fallback error on non-zero exit without stderr', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild as any);

    const backend = new KimiScoutBackend();
    const promise = backend.run({
      prompt: 'Trigger failure',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
    });

    mockChild.stdout.emit('data', 'partial-output');
    mockChild.emit('close', 7);

    const result = await promise;

    expect(result).toMatchObject({
      success: false,
      output: 'partial-output',
      error: 'kimi exited with code 7',
    });
  });

  it('returns stderr for non-zero exit when stderr is present', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild as any);

    const backend = new KimiScoutBackend();
    const promise = backend.run({
      prompt: 'Trigger stderr failure',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
    });

    mockChild.stderr.emit('data', 'fatal stderr');
    mockChild.emit('close', 3);

    const result = await promise;

    expect(result).toMatchObject({
      success: false,
      output: '',
      error: 'fatal stderr',
    });
  });

  it('kills on timeout and returns timeout result', async () => {
    vi.useFakeTimers();
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild as any);

    const backend = new KimiScoutBackend();
    const promise = backend.run({
      prompt: 'Long running scan',
      cwd: '/tmp/repo',
      timeoutMs: 50,
    });

    mockChild.stdout.emit('data', 'partial-timeout-output');

    await vi.advanceTimersByTimeAsync(50);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    mockChild.emit('close', null);
    const result = await promise;

    expect(result).toMatchObject({
      success: false,
      output: 'partial-timeout-output',
      error: 'Timeout exceeded',
    });
  });

  it('short-circuits when signal is already aborted', async () => {
    const backend = new KimiScoutBackend();
    const abortController = new AbortController();
    abortController.abort();

    const result = await backend.run({
      prompt: 'Should not spawn',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
      signal: abortController.signal,
    });

    expect(result).toEqual({
      success: false,
      output: '',
      error: 'Aborted before start',
      durationMs: 0,
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('kills process on runtime abort and returns aborted result', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild as any);

    const backend = new KimiScoutBackend();
    const abortController = new AbortController();

    const promise = backend.run({
      prompt: 'Abort in flight',
      cwd: '/tmp/repo',
      timeoutMs: 10000,
      signal: abortController.signal,
    });

    abortController.abort();
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    mockChild.emit('close', null);
    const result = await promise;

    expect(result).toMatchObject({
      success: false,
      error: 'Aborted by signal',
    });
  });
});

function createMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  return child;
}
