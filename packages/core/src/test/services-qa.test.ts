import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { DatabaseAdapter } from '../db/adapter.js';
import type { ExecRunner, ExecResult } from '../exec/types.js';
import type { QaDeps, QaConfig, QaRunOptions, QaLogger } from '../services/qa.js';

// Mock repos
vi.mock('../repos/runs.js', () => ({
  create: vi.fn(),
  markSuccess: vi.fn(),
  markFailure: vi.fn(),
  getById: vi.fn(),
}));

vi.mock('../repos/run_steps.js', () => ({
  createMany: vi.fn(),
  markStarted: vi.fn(),
  markSuccess: vi.fn(),
  markFailed: vi.fn(),
  markSkipped: vi.fn(),
  markCanceled: vi.fn(),
  listByRun: vi.fn(),
  getSummary: vi.fn(),
}));

import * as runs from '../repos/runs.js';
import * as runSteps from '../repos/run_steps.js';
import { runQa, getQaRunDetails } from '../services/qa.js';

function makeExecOutput(overrides?: Partial<ExecResult['stdout']>) {
  return {
    path: 'artifacts/stdout.log',
    absPath: '/tmp/artifacts/stdout.log',
    bytes: 0,
    truncated: false,
    tail: '',
    ...overrides,
  };
}

function makeExecResult(overrides?: Partial<ExecResult>): ExecResult {
  return {
    status: 'success',
    exitCode: 0,
    signal: null,
    pid: 1234,
    startedAtMs: 1000,
    endedAtMs: 2000,
    durationMs: 1000,
    stdout: makeExecOutput(),
    stderr: makeExecOutput(),
    ...overrides,
  };
}

function makeStep(overrides?: Record<string, unknown>) {
  return {
    id: 'step-1',
    runId: 'run-1',
    attempt: 1,
    ordinal: 0,
    name: 'lint',
    kind: 'command',
    status: 'queued',
    cmd: 'npm run lint',
    cwd: '.',
    timeoutMs: null,
    exitCode: null,
    signal: null,
    startedAtMs: null,
    endedAtMs: null,
    durationMs: null,
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutTail: null,
    stderrTail: null,
    errorMessage: null,
    metadata: {},
    createdAtMs: Date.now(),
    ...overrides,
  };
}

function makeDeps(execOverride?: ExecRunner['run']): QaDeps {
  return {
    db: {} as DatabaseAdapter,
    exec: {
      run: execOverride ?? vi.fn().mockResolvedValue(makeExecResult()),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function makeConfig(overrides?: Partial<QaConfig>): QaConfig {
  return {
    commands: [
      { name: 'lint', cmd: 'npm run lint' },
      { name: 'test', cmd: 'npm test' },
    ],
    artifacts: { dir: '.artifacts', maxLogBytes: 1024, tailBytes: 512 },
    retry: { enabled: false, maxAttempts: 1 },
    ...overrides,
  };
}

function makeOpts(overrides?: Partial<QaRunOptions>): QaRunOptions {
  return {
    projectId: 'proj-1',
    repoRoot: '/repo',
    config: makeConfig(),
    ...overrides,
  };
}

describe('runQa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runs.create).mockResolvedValue({
      id: 'run-1',
      ticketId: null,
      projectId: 'proj-1',
      type: 'qa',
      status: 'pending',
      iteration: 1,
      maxIterations: 1,
      startedAt: null,
      completedAt: null,
      error: null,
      metadata: {},
      createdAt: new Date(),
    });
    vi.mocked(runs.markSuccess).mockResolvedValue(undefined as any);
    vi.mocked(runs.markFailure).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.createMany).mockImplementation(
      async (_db, _runId, cmds, _attempt) =>
        cmds.map((c: any, i: number) =>
          makeStep({ id: `step-${i}`, ordinal: i, name: c.name, cmd: c.cmd })
        )
    );
    vi.mocked(runSteps.markStarted).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markSuccess).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markFailed).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markSkipped).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markCanceled).mockResolvedValue(undefined as any);
  });

  it('creates a run in the database', async () => {
    const deps = makeDeps();
    await runQa(deps, makeOpts());

    expect(runs.create).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        projectId: 'proj-1',
        type: 'qa',
      })
    );
  });

  it('executes all commands in order', async () => {
    const execFn = vi.fn().mockResolvedValue(makeExecResult());
    const deps = makeDeps(execFn);

    await runQa(deps, makeOpts());

    expect(execFn).toHaveBeenCalledTimes(2);
    // First call should be lint, second test
    expect(execFn.mock.calls[0][0]).toMatchObject({ cmd: 'npm run lint' });
    expect(execFn.mock.calls[1][0]).toMatchObject({ cmd: 'npm test' });
  });

  it('records step results', async () => {
    const deps = makeDeps();
    await runQa(deps, makeOpts());

    // Both steps succeed
    expect(runSteps.markStarted).toHaveBeenCalledTimes(2);
    expect(runSteps.markSuccess).toHaveBeenCalledTimes(2);
  });

  it('returns success when all commands pass', async () => {
    const deps = makeDeps();
    const result = await runQa(deps, makeOpts());

    expect(result.status).toBe('success');
    expect(result.runId).toBe('run-1');
    expect(result.projectId).toBe('proj-1');
  });

  it('returns failed when a command fails', async () => {
    const execFn = vi
      .fn()
      .mockResolvedValueOnce(makeExecResult()) // lint passes
      .mockResolvedValueOnce(
        makeExecResult({ status: 'failed', exitCode: 1 })
      ); // test fails

    const deps = makeDeps(execFn);
    const result = await runQa(deps, makeOpts());

    expect(result.status).toBe('failed');
    expect(result.failedAt).toEqual({ attempt: 1, stepName: 'test' });
  });

  it('respects retry config', async () => {
    const execFn = vi
      .fn()
      // Attempt 1: lint pass, test fail
      .mockResolvedValueOnce(makeExecResult())
      .mockResolvedValueOnce(makeExecResult({ status: 'failed', exitCode: 1 }))
      // Attempt 2: both pass
      .mockResolvedValueOnce(makeExecResult())
      .mockResolvedValueOnce(makeExecResult());

    const deps = makeDeps(execFn);
    const config = makeConfig({ retry: { enabled: true, maxAttempts: 2 } });
    const result = await runQa(deps, makeOpts({ config }));

    expect(result.status).toBe('success');
    expect(result.attempts).toBe(2);
    expect(execFn).toHaveBeenCalledTimes(4);
  });

  it('records duration', async () => {
    const deps = makeDeps();
    const result = await runQa(deps, makeOpts());

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAtMs).toBeGreaterThan(0);
    expect(result.endedAtMs).toBeGreaterThanOrEqual(result.startedAtMs);
  });

  it('handles cancellation via abort signal', async () => {
    const controller = new AbortController();
    controller.abort(); // abort immediately

    const deps = makeDeps();
    const result = await runQa(deps, makeOpts({ signal: controller.signal }));

    expect(result.status).toBe('canceled');
    expect(runs.markFailure).toHaveBeenCalledWith(
      deps.db,
      'run-1',
      expect.stringContaining('Canceled'),
      expect.any(Object)
    );
  });
});

describe('runQa orchestration regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runs.create).mockResolvedValue({
      id: 'run-1',
      ticketId: null,
      projectId: 'proj-1',
      type: 'qa',
      status: 'pending',
      iteration: 1,
      maxIterations: 1,
      startedAt: null,
      completedAt: null,
      error: null,
      metadata: {},
      createdAt: new Date(),
    });
    vi.mocked(runs.markSuccess).mockResolvedValue(undefined as any);
    vi.mocked(runs.markFailure).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.createMany).mockImplementation(
      async (_db, _runId, cmds, attempt) =>
        cmds.map((c: any, i: number) =>
          makeStep({
            id: `step-${attempt}-${i}`,
            attempt,
            ordinal: i,
            name: c.name,
            cmd: c.cmd,
          })
        )
    );
    vi.mocked(runSteps.markStarted).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markSuccess).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markFailed).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markSkipped).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markCanceled).mockResolvedValue(undefined as any);
  });

  it('succeeds on the first attempt and does not retry when retries are enabled', async () => {
    const execFn = vi.fn().mockResolvedValue(makeExecResult());
    const deps = makeDeps(execFn);
    const config = makeConfig({ retry: { enabled: true, maxAttempts: 3 } });

    const result = await runQa(deps, makeOpts({ config }));

    expect(result.status).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.latestAttempt).toBe(1);
    expect(runSteps.createMany).toHaveBeenCalledTimes(1);
    expect(execFn).toHaveBeenCalledTimes(config.commands.length);
    expect(runs.markSuccess).toHaveBeenCalledWith(
      deps.db,
      'run-1',
      expect.objectContaining({ attempts: 1, durationMs: expect.any(Number) })
    );
    expect(runSteps.markFailed).not.toHaveBeenCalled();
    expect(runSteps.markSkipped).not.toHaveBeenCalled();
    expect(runSteps.markCanceled).not.toHaveBeenCalled();
    expect(runs.markFailure).not.toHaveBeenCalled();
  });

  it('retries after a step failure, skips remaining steps in failed attempt, and succeeds on next attempt', async () => {
    const execFn = vi
      .fn()
      // Attempt 1: lint success, test failure
      .mockResolvedValueOnce(makeExecResult())
      .mockResolvedValueOnce(makeExecResult({ status: 'failed', exitCode: 1 }))
      // Attempt 2: all success
      .mockResolvedValueOnce(makeExecResult())
      .mockResolvedValueOnce(makeExecResult())
      .mockResolvedValueOnce(makeExecResult());
    const deps = makeDeps(execFn);
    const config = makeConfig({
      commands: [
        { name: 'lint', cmd: 'npm run lint' },
        { name: 'test', cmd: 'npm test' },
        { name: 'typecheck', cmd: 'npm run typecheck' },
      ],
      retry: { enabled: true, maxAttempts: 2 },
    });

    const result = await runQa(deps, makeOpts({ config }));

    expect(result.status).toBe('success');
    expect(result.attempts).toBe(2);
    expect(result.failedAt).toBeUndefined();
    expect(runSteps.createMany).toHaveBeenCalledTimes(2);
    expect(runSteps.markFailed).toHaveBeenCalledTimes(1);
    expect(runSteps.markFailed).toHaveBeenCalledWith(
      deps.db,
      'step-1-1',
      expect.objectContaining({
        exitCode: 1,
        errorMessage: 'Exited with code 1',
        metadata: { execStatus: 'failed' },
      })
    );
    expect(runSteps.markSkipped).toHaveBeenCalledWith(
      deps.db,
      'step-1-2',
      'Skipped (previous step "test" failed)'
    );
    expect(runSteps.markSkipped).toHaveBeenCalledTimes(1);
    expect(execFn).toHaveBeenCalledTimes(5);
    expect(runs.markSuccess).toHaveBeenCalledWith(
      deps.db,
      'run-1',
      expect.objectContaining({ attempts: 2, durationMs: expect.any(Number) })
    );
    expect(runs.markFailure).not.toHaveBeenCalled();
  });

  it('fails after max attempts and records terminal failure from the final attempt', async () => {
    const execFn = vi
      .fn()
      // Attempt 1: first step fails
      .mockResolvedValueOnce(makeExecResult({ status: 'failed', exitCode: 2 }))
      // Attempt 2: first step fails again
      .mockResolvedValueOnce(makeExecResult({ status: 'failed', exitCode: 3 }));
    const deps = makeDeps(execFn);
    const config = makeConfig({ retry: { enabled: true, maxAttempts: 2 } });

    const result = await runQa(deps, makeOpts({ config }));

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(2);
    expect(result.failedAt).toEqual({ attempt: 2, stepName: 'lint' });
    expect(execFn).toHaveBeenCalledTimes(2);
    expect(runSteps.markFailed).toHaveBeenCalledTimes(2);
    expect(runSteps.markSkipped).toHaveBeenNthCalledWith(
      1,
      deps.db,
      'step-1-1',
      'Skipped (previous step "lint" failed)'
    );
    expect(runSteps.markSkipped).toHaveBeenNthCalledWith(
      2,
      deps.db,
      'step-2-1',
      'Skipped (previous step "lint" failed)'
    );
    expect(runs.markFailure).toHaveBeenCalledWith(
      deps.db,
      'run-1',
      'Failed at lint (attempt 2)',
      expect.objectContaining({
        attempts: 2,
        failedAt: { attempt: 2, stepName: 'lint' },
        durationMs: expect.any(Number),
      })
    );
    expect(runs.markSuccess).not.toHaveBeenCalled();
  });

  it('cancels before the first attempt and persists zero-attempt finalization metadata', async () => {
    const controller = new AbortController();
    controller.abort();
    const execFn = vi.fn().mockResolvedValue(makeExecResult());
    const deps = makeDeps(execFn);
    const config = makeConfig({ retry: { enabled: true, maxAttempts: 3 } });

    const result = await runQa(
      deps,
      makeOpts({ config, signal: controller.signal })
    );

    expect(result.status).toBe('canceled');
    expect(result.attempts).toBe(0);
    expect(result.latestAttempt).toBe(0);
    expect(result.failedAt).toBeUndefined();
    expect(runSteps.createMany).not.toHaveBeenCalled();
    expect(runSteps.markStarted).not.toHaveBeenCalled();
    expect(runSteps.markSuccess).not.toHaveBeenCalled();
    expect(runSteps.markFailed).not.toHaveBeenCalled();
    expect(runSteps.markSkipped).not.toHaveBeenCalled();
    expect(runSteps.markCanceled).not.toHaveBeenCalled();
    expect(execFn).not.toHaveBeenCalled();
    expect(runs.markFailure).toHaveBeenCalledWith(
      deps.db,
      'run-1',
      'Canceled before start',
      expect.objectContaining({ attempts: 0 })
    );
    expect(runs.markSuccess).not.toHaveBeenCalled();
  });

  it('cancels remaining steps mid-attempt and does not continue retrying', async () => {
    const controller = new AbortController();
    const execFn = vi.fn().mockImplementation(async () => {
      controller.abort();
      return makeExecResult();
    });
    const deps = makeDeps(execFn);
    const config = makeConfig({
      commands: [
        { name: 'lint', cmd: 'npm run lint' },
        { name: 'test', cmd: 'npm test' },
        { name: 'typecheck', cmd: 'npm run typecheck' },
      ],
      retry: { enabled: true, maxAttempts: 3 },
    });

    const result = await runQa(
      deps,
      makeOpts({ config, signal: controller.signal })
    );

    expect(result.status).toBe('canceled');
    expect(result.attempts).toBe(1);
    expect(result.failedAt).toEqual({ attempt: 1, stepName: 'test' });
    expect(runSteps.createMany).toHaveBeenCalledTimes(1);
    expect(execFn).toHaveBeenCalledTimes(1);
    expect(runSteps.markSuccess).toHaveBeenCalledTimes(1);
    expect(runSteps.markCanceled).toHaveBeenNthCalledWith(
      1,
      deps.db,
      'step-1-1',
      'Canceled by user'
    );
    expect(runSteps.markCanceled).toHaveBeenNthCalledWith(
      2,
      deps.db,
      'step-1-2',
      'Canceled by user'
    );
    expect(runSteps.markSkipped).not.toHaveBeenCalled();
    expect(runs.markFailure).toHaveBeenCalledWith(
      deps.db,
      'run-1',
      'Failed at test (attempt 1)',
      expect.objectContaining({
        attempts: 1,
        failedAt: { attempt: 1, stepName: 'test' },
        durationMs: expect.any(Number),
      })
    );
  });

  it('finalizes unexpected exec errors with metadata and rethrows the original error', async () => {
    const originalError = new Error('exec boom');
    const execFn = vi.fn().mockRejectedValue(originalError);
    const deps = makeDeps(execFn);

    await expect(runQa(deps, makeOpts())).rejects.toBe(originalError);
    expect(runSteps.markStarted).toHaveBeenCalledTimes(1);
    expect(runSteps.markFailed).not.toHaveBeenCalled();
    expect(runSteps.markSkipped).not.toHaveBeenCalled();
    expect(runSteps.markCanceled).not.toHaveBeenCalled();
    expect(runs.markFailure).toHaveBeenCalledWith(
      deps.db,
      'run-1',
      'QA orchestration error: exec boom',
      expect.objectContaining({
        attempts: 1,
        failedAt: undefined,
        durationMs: expect.any(Number),
      })
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      'QA run failed unexpectedly: exec boom'
    );
  });

  it('attempts markFailure on orchestration error and rethrows the original error when finalization fails', async () => {
    const originalError = new Error('exec boom');
    const finalizeError = new Error('finalize boom');
    const execFn = vi.fn().mockRejectedValue(originalError);
    const deps = makeDeps(execFn);

    vi.mocked(runs.markFailure).mockRejectedValueOnce(finalizeError);

    await expect(runQa(deps, makeOpts())).rejects.toBe(originalError);
    expect(runs.markFailure).toHaveBeenCalledWith(
      deps.db,
      'run-1',
      'QA orchestration error: exec boom',
      expect.objectContaining({ attempts: 1, durationMs: expect.any(Number) })
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      'Failed to finalize QA run after error: finalize boom'
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      'QA run failed unexpectedly: exec boom'
    );
  });
});

describe('getQaRunDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for non-existent run', async () => {
    vi.mocked(runs.getById).mockResolvedValue(null);

    const db = {} as DatabaseAdapter;
    const result = await getQaRunDetails(db, 'nonexistent');

    expect(result).toBeNull();
  });

  it('returns run, steps, and summary for existing run', async () => {
    const mockRun = {
      id: 'run-1',
      ticketId: null,
      projectId: 'proj-1',
      type: 'qa' as const,
      status: 'success' as const,
      iteration: 1,
      maxIterations: 1,
      startedAt: new Date(),
      completedAt: new Date(),
      error: null,
      metadata: {},
      createdAt: new Date(),
    };
    const mockSteps = [makeStep()];
    const mockSummary = {
      total: 1,
      success: 1,
      failed: 0,
      skipped: 0,
      canceled: 0,
      queued: 0,
      running: 0,
    };

    vi.mocked(runs.getById).mockResolvedValue(mockRun);
    vi.mocked(runSteps.listByRun).mockResolvedValue(mockSteps as any);
    vi.mocked(runSteps.getSummary).mockResolvedValue(mockSummary as any);

    const db = {} as DatabaseAdapter;
    const result = await getQaRunDetails(db, 'run-1');

    expect(result).not.toBeNull();
    expect(result!.run).toBe(mockRun);
    expect(result!.steps).toBe(mockSteps);
    expect(result!.summary).toBe(mockSummary);
  });
});
