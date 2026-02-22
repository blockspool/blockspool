import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseAdapter } from '../db/adapter.js';
import type { ExecResult, ExecRunner } from '../exec/types.js';
import type { QaConfig, QaDeps, QaRunOptions } from '../services/qa.js';

vi.mock('../repos/runs.js', () => ({
  create: vi.fn(),
  markSuccess: vi.fn(),
  markFailure: vi.fn(),
}));

vi.mock('../repos/run_steps.js', () => ({
  createMany: vi.fn(),
  markStarted: vi.fn(),
  markSuccess: vi.fn(),
  markFailed: vi.fn(),
  markSkipped: vi.fn(),
  markCanceled: vi.fn(),
}));

import * as runs from '../repos/runs.js';
import * as runSteps from '../repos/run_steps.js';
import { runQa } from '../services/qa.js';

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
    commands: [{ name: 'lint', cmd: 'npm run lint' }],
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

describe('runQa attempt validation and unexpected finalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(runs.create).mockResolvedValue({
      id: 'run-1',
      ticketId: null,
      projectId: 'proj-1',
      type: 'qa',
      status: 'running',
      iteration: 1,
      maxIterations: 1,
      startedAt: new Date(),
      completedAt: null,
      error: null,
      metadata: {},
      createdAt: new Date(),
    });
    vi.mocked(runs.markSuccess).mockResolvedValue(undefined as any);
    vi.mocked(runs.markFailure).mockResolvedValue(undefined as any);

    vi.mocked(runSteps.createMany).mockResolvedValue([
      {
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
        updatedAtMs: Date.now(),
      } as any,
    ]);
    vi.mocked(runSteps.markStarted).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markSuccess).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markFailed).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markSkipped).mockResolvedValue(undefined as any);
    vi.mocked(runSteps.markCanceled).mockResolvedValue(undefined as any);
  });

  it('rejects maxAttemptsOverride values below 1 before creating a run', async () => {
    const deps = makeDeps();

    await expect(
      runQa(deps, makeOpts({ maxAttemptsOverride: 0 }))
    ).rejects.toThrow('QA maxAttemptsOverride must be >= 1');
    expect(runs.create).not.toHaveBeenCalled();
  });

  it('rejects retry.maxAttempts values below 1 when retries are enabled', async () => {
    const deps = makeDeps();
    const config = makeConfig({ retry: { enabled: true, maxAttempts: 0 } });

    await expect(runQa(deps, makeOpts({ config }))).rejects.toThrow(
      'QA retry.maxAttempts must be >= 1'
    );
    expect(runs.create).not.toHaveBeenCalled();
  });

  it('marks the run as failed when exec.run throws unexpectedly', async () => {
    const deps = makeDeps(vi.fn().mockRejectedValue(new Error('exec boom')));

    await expect(runQa(deps, makeOpts())).rejects.toThrow('exec boom');
    expect(runs.markFailure).toHaveBeenCalledWith(
      deps.db,
      'run-1',
      'QA orchestration error: exec boom',
      expect.objectContaining({
        attempts: 1,
        durationMs: expect.any(Number),
      })
    );
  });

  it('marks the run as failed when step creation throws unexpectedly', async () => {
    const deps = makeDeps();
    vi.mocked(runSteps.createMany).mockRejectedValue(new Error('db boom'));

    await expect(runQa(deps, makeOpts())).rejects.toThrow('db boom');
    expect(runs.markFailure).toHaveBeenCalledWith(
      deps.db,
      'run-1',
      'QA orchestration error: db boom',
      expect.objectContaining({
        attempts: 1,
        durationMs: expect.any(Number),
      })
    );
  });
});
