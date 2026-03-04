import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to mock child_process.exec properly so that when gitExec does
// `await import('child_process')` and then promisifies exec, it gets our mock.
// The key insight: vi.mock intercepts ALL imports of 'child_process', including
// dynamic imports inside functions.

// Create mock exec/execFile functions that we can control in tests
const mockExec = vi.fn();
const mockExecFile = vi.fn();

vi.mock('child_process', () => ({
  exec: mockExec,
  execFile: mockExecFile,
}));

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'node:fs';
import {
  withGitMutex,
  cleanupWorktree,
  createMilestoneBranch,
  mergeTicketToMilestone,
} from '../lib/solo-git.js';

describe('withGitMutex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes concurrent operations', async () => {
    const order: number[] = [];
    let resolveFirst: () => void;
    const firstBlocks = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const first = withGitMutex(async () => {
      order.push(1);
      await firstBlocks;
      order.push(2);
      return 'first';
    });

    const second = withGitMutex(async () => {
      order.push(3);
      return 'second';
    });

    // Give microtasks a chance to run - second should not start yet
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1]);

    resolveFirst!();
    await first;
    await second;

    expect(order).toEqual([1, 2, 3]);
  });

  it('returns the value from the inner function', async () => {
    const result = await withGitMutex(async () => 42);
    expect(result).toBe(42);
  });

  it('propagates errors from inner function', async () => {
    await expect(
      withGitMutex(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });
});

describe('cleanupWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // cleanupWorktree uses gitExecFile (child_process.execFile)
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: unknown, callback: Function) => {
      callback(null, { stdout: '', stderr: '' });
    });
  });

  it('calls git worktree remove when path exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await cleanupWorktree('/repo', '/repo/.promptwheel/worktrees/test');

    expect(fs.existsSync).toHaveBeenCalledWith('/repo/.promptwheel/worktrees/test');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'remove']),
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function)
    );
  });

  it('silently succeeds when path does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(
      cleanupWorktree('/repo', '/repo/.promptwheel/worktrees/test')
    ).resolves.toBeUndefined();

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('ignores errors from git command', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: unknown, callback: Function) => {
      callback(new Error('git failed'));
    });

    await expect(
      cleanupWorktree('/repo', '/repo/.promptwheel/worktrees/test')
    ).resolves.toBeUndefined();
  });
});

describe('createMilestoneBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // createMilestoneBranch uses gitExecFile (child_process.execFile)
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: unknown, callback: Function) => {
      callback(null, { stdout: '', stderr: '' });
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('returns branch name and worktree path', async () => {
    const result = await createMilestoneBranch('/repo', 'main');

    expect(result).toHaveProperty('milestoneBranch');
    expect(result).toHaveProperty('milestoneWorktreePath');
    expect(typeof result.milestoneBranch).toBe('string');
    expect(typeof result.milestoneWorktreePath).toBe('string');
  });

  it('branch name starts with promptwheel/milestone-', async () => {
    const result = await createMilestoneBranch('/repo', 'main');

    expect(result.milestoneBranch).toMatch(/^promptwheel\/milestone-/);
  });

  it('creates worktrees directory', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await createMilestoneBranch('/repo', 'main');

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('worktrees'),
      { recursive: true }
    );
  });

  it('fetches origin', async () => {
    await createMilestoneBranch('/repo', 'main');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin', 'main'],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function)
    );
  });

  it('creates branch and worktree', async () => {
    await createMilestoneBranch('/repo', 'main');

    // Should create branch from origin/main
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['branch']),
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function)
    );

    // Should add worktree
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'add']),
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function)
    );
  });
});

describe('mergeTicketToMilestone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success on clean merge', async () => {
    // The first merge uses gitExecFile
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: unknown, callback: Function) => {
      callback(null, { stdout: '', stderr: '' });
    });

    const result = await mergeTicketToMilestone(
      '/repo',
      'feature-branch',
      '/repo/.promptwheel/worktrees/_milestone'
    );

    expect(result).toEqual({ success: true, conflicted: false });
  });

  it('returns conflicted when merge fails and rebase fails', async () => {
    // All operations use gitExecFile (execFile). Call sequence:
    // 1. merge --no-ff (fail)
    // 2. merge --abort (success)
    // 3. rev-parse --abbrev-ref HEAD (returns branch name)
    // 4. rebase (fail)
    // 5-8. abort/cleanup commands (succeed)
    let execFileCallCount = 0;
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: unknown, callback: Function) => {
      execFileCallCount++;
      if (execFileCallCount === 1) {
        // First merge fails
        callback(new Error('merge conflict'));
      } else if (execFileCallCount === 3) {
        // rev-parse returns branch name
        callback(null, { stdout: 'promptwheel/milestone-abc\n', stderr: '' });
      } else if (execFileCallCount === 4) {
        // rebase fails
        callback(new Error('rebase conflict'));
      } else {
        // abort/cleanup commands succeed
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const result = await mergeTicketToMilestone(
      '/repo',
      'feature-branch',
      '/repo/.promptwheel/worktrees/_milestone'
    );

    expect(result).toEqual({ success: false, conflicted: true });
  });

  it('retries with rebase on first failure then succeeds', async () => {
    // All operations use gitExecFile (execFile). Call sequence:
    // 1. merge --no-ff (fail)
    // 2. merge --abort (success)
    // 3. rev-parse --abbrev-ref HEAD (returns branch name)
    // 4. rebase (success)
    // 5. checkout (success)
    // 6. merge --no-ff (success)
    let execFileCallCount = 0;
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: unknown, callback: Function) => {
      execFileCallCount++;
      if (execFileCallCount === 1) {
        // First merge fails
        callback(new Error('merge conflict'));
      } else if (execFileCallCount === 3) {
        // rev-parse returns branch name
        callback(null, { stdout: 'promptwheel/milestone-abc\n', stderr: '' });
      } else {
        // merge --abort, rebase, checkout, second merge succeed
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const result = await mergeTicketToMilestone(
      '/repo',
      'feature-branch',
      '/repo/.promptwheel/worktrees/_milestone'
    );

    expect(result).toEqual({ success: true, conflicted: false });
  });
});
