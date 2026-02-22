import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseAdapter } from '../db/adapter.js';
import type { GitService, ScoutDeps } from '../services/scout.js';
import type { TicketProposal } from '../scout/index.js';

vi.mock('../scout/index.js', () => ({
  scout: vi.fn(),
}));

vi.mock('../repos/projects.js', () => ({
  ensureForRepo: vi.fn(),
}));

vi.mock('../repos/tickets.js', () => ({
  createMany: vi.fn(),
  getRecentlyCompleted: vi.fn(),
}));

vi.mock('../repos/runs.js', () => ({
  create: vi.fn(),
  getById: vi.fn(),
  markSuccess: vi.fn(),
  markFailure: vi.fn(),
}));

import { scoutRepo } from '../services/scout.js';
import { scout as scanAndPropose } from '../scout/index.js';
import * as projects from '../repos/projects.js';
import * as tickets from '../repos/tickets.js';
import * as runs from '../repos/runs.js';

function makeProposal(overrides: Partial<TicketProposal> = {}): TicketProposal {
  return {
    id: 'scout-partial-1',
    category: 'fix',
    title: 'Fix flaky parser edge case',
    description: 'Handle truncated payload input safely',
    acceptance_criteria: ['Parser handles truncated payload without throwing'],
    verification_commands: ['npm test -- parser'],
    allowed_paths: ['src/parser/**'],
    files: ['src/parser/index.ts'],
    confidence: 85,
    rationale: 'Prevents runtime crash',
    estimated_complexity: 'simple',
    ...overrides,
  };
}

function makeFakeDb(): DatabaseAdapter {
  return {
    name: 'mock',
    connected: true,
    query: vi.fn(),
    withTransaction: vi.fn((fn) => fn({ query: vi.fn() })),
    migrate: vi.fn(),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

function makeFakeGit(): GitService {
  return {
    findRepoRoot: vi.fn().mockResolvedValue('/repo'),
    getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/test/repo'),
    getProjectId: vi.fn().mockReturnValue('proj_abc123'),
  };
}

function makeDeps(overrides: Partial<ScoutDeps> = {}): ScoutDeps {
  return {
    db: makeFakeDb(),
    git: makeFakeGit(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

const fakeProject = {
  id: 'proj_abc123',
  name: 'repo',
  repoUrl: 'https://github.com/test/repo',
  rootPath: '/repo',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeRun = {
  id: 'run_xyz',
  projectId: 'proj_abc123',
  ticketId: null,
  type: 'scout' as const,
  status: 'running' as const,
  iteration: 0,
  maxIterations: 10,
  startedAt: new Date(),
  completedAt: null,
  error: null,
  metadata: {},
  createdAt: new Date(),
};

describe('scoutRepo incomplete scan handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projects.ensureForRepo).mockResolvedValue(fakeProject);
    vi.mocked(runs.create).mockResolvedValue(fakeRun);
    vi.mocked(runs.getById).mockResolvedValue({
      ...fakeRun,
      status: 'failure' as const,
      completedAt: new Date(),
      error: 'Batch 2 failed: timeout',
    });
    vi.mocked(runs.markSuccess).mockResolvedValue(null);
    vi.mocked(runs.markFailure).mockResolvedValue(null);
    vi.mocked(tickets.getRecentlyCompleted).mockResolvedValue([]);
    vi.mocked(tickets.createMany).mockResolvedValue([]);
  });

  it('marks the run as failure when scout returns success false', async () => {
    const proposal = makeProposal();
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: false,
      proposals: [proposal],
      errors: ['Batch 2 failed: timeout'],
      scannedFiles: 12,
      scanDurationMs: 1234,
    });

    const result = await scoutRepo(makeDeps(), { autoApprove: true });

    expect(result.success).toBe(false);
    expect(result.proposals).toHaveLength(1);
    expect(result.errors).toEqual(['Batch 2 failed: timeout']);
    expect(result.tickets).toHaveLength(0);

    expect(runs.markFailure).toHaveBeenCalledWith(
      expect.anything(),
      fakeRun.id,
      'Batch 2 failed: timeout',
      expect.objectContaining({
        scannedFiles: 12,
        proposalCount: 1,
        durationMs: expect.any(Number),
      }),
    );
    expect(runs.markSuccess).not.toHaveBeenCalled();
    expect(tickets.createMany).not.toHaveBeenCalled();
  });

  it('uses a fallback error message when scout failure has no errors', async () => {
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: false,
      proposals: [],
      errors: [],
      scannedFiles: 4,
      scanDurationMs: 500,
    });

    const result = await scoutRepo(makeDeps());

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(['Scout scan did not complete successfully']);
    expect(runs.markFailure).toHaveBeenCalledWith(
      expect.anything(),
      fakeRun.id,
      'Scout scan did not complete successfully',
      expect.objectContaining({
        scannedFiles: 4,
        proposalCount: 0,
        durationMs: expect.any(Number),
      }),
    );
    expect(runs.markSuccess).not.toHaveBeenCalled();
  });
});
