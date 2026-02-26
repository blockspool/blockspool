import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseAdapter } from '../db/adapter.js';
import type { GitService, ScoutDeps, ScoutProgress } from '../services/scout.js';

// Mock the scout/index.js module
vi.mock('../scout/index.js', () => ({
  scout: vi.fn(),
}));

// Mock repos
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

import { scoutRepo, approveProposals } from '../services/scout.js';
import { scout as scanAndPropose } from '../scout/index.js';
import * as projects from '../repos/projects.js';
import * as tickets from '../repos/tickets.js';
import * as runs from '../repos/runs.js';
import type { TicketProposal } from '../scout/index.js';

function makeProposal(overrides: Partial<TicketProposal> = {}): TicketProposal {
  return {
    id: 'scout-123-abc',
    category: 'refactor',
    title: 'Refactor utils module',
    description: 'Extract shared helpers',
    acceptance_criteria: ['Tests pass', 'No regressions'],
    verification_commands: ['npm test'],
    allowed_paths: ['src/utils/**'],
    files: ['src/utils/index.ts'],
    confidence: 80,
    rationale: 'Reduces duplication',
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

describe('scoutRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projects.ensureForRepo).mockResolvedValue(fakeProject);
    vi.mocked(runs.create).mockResolvedValue(fakeRun);
    vi.mocked(runs.getById).mockResolvedValue({ ...fakeRun, status: 'success' as const });
    vi.mocked(runs.markSuccess).mockResolvedValue(null);
    vi.mocked(runs.markFailure).mockResolvedValue(null);
    vi.mocked(tickets.getRecentlyCompleted).mockResolvedValue([]);
    vi.mocked(tickets.createMany).mockResolvedValue([]);
  });

  it('creates or gets project', async () => {
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [],
      errors: [],
      scannedFiles: 5,
    });

    const deps = makeDeps();
    await scoutRepo(deps, { path: '/repo' });

    expect(projects.ensureForRepo).toHaveBeenCalledWith(deps.db, expect.objectContaining({
      id: 'proj_abc123',
      rootPath: '/repo',
    }));
  });

  it('calls scout with correct options', async () => {
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [],
      errors: [],
      scannedFiles: 10,
    });

    await scoutRepo(makeDeps(), {
      path: '/repo',
      scope: 'lib/**',
      maxProposals: 5,
      minConfidence: 70,
      model: 'sonnet',
    });

    expect(scanAndPropose).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'lib/**',
      maxProposals: 5,
      minConfidence: 70,
      projectPath: '/repo',
      model: 'sonnet',
    }));
  });

  it('forwards explicit timeout to scout', async () => {
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [],
      errors: [],
      scannedFiles: 2,
    });

    await scoutRepo(makeDeps(), {
      path: '/repo',
      timeoutMs: 45000,
    });

    expect(scanAndPropose).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 45000,
    }));
  });

  it('does not inject timeout when not provided', async () => {
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [],
      errors: [],
      scannedFiles: 2,
    });

    await scoutRepo(makeDeps(), {
      path: '/repo',
    });

    expect(scanAndPropose).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: undefined,
    }));
  });

  it('stores proposals as tickets when autoApprove', async () => {
    const proposal = makeProposal();
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [proposal],
      errors: [],
      scannedFiles: 3,
    });

    const fakeTicket = {
      id: 'tkt_001',
      projectId: 'proj_abc123',
      title: proposal.title,
      description: 'desc',
      status: 'ready' as const,
      priority: 80,
      shard: null,
      category: 'refactor' as const,
      allowedPaths: ['src/utils/**'],
      forbiddenPaths: [],
      verificationCommands: ['npm test'],
      maxRetries: 3,
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(tickets.createMany).mockResolvedValue([fakeTicket]);

    const result = await scoutRepo(makeDeps(), { autoApprove: true });

    expect(tickets.createMany).toHaveBeenCalled();
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].title).toBe(proposal.title);
  });

  it('tracks run lifecycle metadata for a successful auto-approved scan', async () => {
    const proposal = makeProposal({
      title: 'Stabilize parser timeout handling',
      category: 'fix',
      confidence: 90,
    });
    const deps = makeDeps();

    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [proposal],
      errors: [],
      scannedFiles: 11,
      scanDurationMs: 800,
    });
    vi.mocked(tickets.getRecentlyCompleted).mockResolvedValue([
      { title: 'Previously completed parser cleanup' } as any,
    ]);
    vi.mocked(tickets.createMany).mockResolvedValue([
      {
        id: 'tkt_100',
        projectId: fakeProject.id,
        title: proposal.title,
        description: 'desc',
        status: 'ready' as const,
        priority: proposal.confidence,
        shard: null,
        category: proposal.category,
        allowedPaths: proposal.allowed_paths,
        forbiddenPaths: [],
        verificationCommands: proposal.verification_commands,
        maxRetries: 3,
        retryCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    vi.mocked(runs.getById).mockResolvedValue({
      ...fakeRun,
      status: 'success' as const,
      completedAt: new Date(),
      error: null,
      metadata: {
        scannedFiles: 11,
        proposalCount: 1,
        ticketCount: 1,
      },
    });

    const result = await scoutRepo(deps, {
      path: '/repo',
      scope: 'packages/**',
      maxProposals: 6,
      model: 'sonnet',
      autoApprove: true,
    });

    expect(runs.create).toHaveBeenCalledWith(deps.db, {
      projectId: fakeProject.id,
      type: 'scout',
      metadata: {
        scope: 'packages/**',
        maxProposals: 6,
        model: 'sonnet',
      },
    });
    expect(scanAndPropose).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'packages/**',
      maxProposals: 6,
      projectPath: '/repo',
      model: 'sonnet',
      recentlyCompletedTitles: ['Previously completed parser cleanup'],
    }));
    expect(runs.markSuccess).toHaveBeenCalledWith(
      deps.db,
      fakeRun.id,
      expect.objectContaining({
        scannedFiles: 11,
        proposalCount: 1,
        ticketCount: 1,
        durationMs: expect.any(Number),
      }),
    );
    expect(runs.markFailure).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.run.status).toBe('success');
    expect(result.run.metadata).toEqual(expect.objectContaining({
      scannedFiles: 11,
      proposalCount: 1,
      ticketCount: 1,
    }));
  });

  it('reports progress at each phase', async () => {
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [],
      errors: [],
      scannedFiles: 1,
    });

    const phases: ScoutProgress['phase'][] = [];
    await scoutRepo(makeDeps(), {
      onProgress: (p) => phases.push(p.phase),
    });

    expect(phases).toContain('init');
    expect(phases).toContain('scanning');
    expect(phases).toContain('complete');
  });

  it('marks run failure on incomplete scan and returns scan errors/proposals', async () => {
    const proposal = makeProposal({
      title: 'Fix parser partial output handling',
      category: 'fix',
    });
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: false,
      proposals: [proposal],
      errors: ['Batch 2 failed: timeout'],
      scannedFiles: 12,
      scanDurationMs: 600,
    });
    vi.mocked(runs.getById).mockResolvedValue({
      ...fakeRun,
      status: 'failure' as const,
      completedAt: new Date(),
      error: 'Batch 2 failed: timeout',
      metadata: {
        scannedFiles: 12,
        proposalCount: 1,
      },
    });

    const result = await scoutRepo(makeDeps(), { autoApprove: true });

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
    expect(result.success).toBe(false);
    expect(result.proposals).toHaveLength(1);
    expect(result.tickets).toEqual([]);
    expect(result.errors).toEqual(['Batch 2 failed: timeout']);
    expect(result.scannedFiles).toBe(12);
    expect(result.run.status).toBe('failure');
    expect(result.run.metadata).toEqual(expect.objectContaining({
      scannedFiles: 12,
      proposalCount: 1,
    }));
  });

  it('uses fallback error payload for incomplete scan with empty errors', async () => {
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: false,
      proposals: [],
      errors: [],
      scannedFiles: 4,
      scanDurationMs: 300,
    });
    vi.mocked(runs.getById).mockResolvedValue({
      ...fakeRun,
      status: 'failure' as const,
      completedAt: new Date(),
      error: 'Scout scan did not complete successfully',
      metadata: {
        scannedFiles: 4,
        proposalCount: 0,
      },
    });

    const result = await scoutRepo(makeDeps());

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
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(['Scout scan did not complete successfully']);
    expect(result.run.status).toBe('failure');
  });

  it('handles scout failure gracefully', async () => {
    vi.mocked(scanAndPropose).mockRejectedValue(new Error('LLM timeout'));
    vi.mocked(runs.getById).mockResolvedValue({
      ...fakeRun,
      status: 'failure' as const,
      completedAt: new Date(),
      error: 'LLM timeout',
      metadata: { durationMs: 10 },
    });

    const result = await scoutRepo(makeDeps());

    expect(result.success).toBe(false);
    expect(result.errors).toContain('LLM timeout');
    expect(runs.markFailure).toHaveBeenCalledWith(
      expect.anything(),
      fakeRun.id,
      expect.any(Error),
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
    expect(runs.markSuccess).not.toHaveBeenCalled();
    expect(result.run.status).toBe('failure');
    expect(result.proposals).toEqual([]);
    expect(result.tickets).toEqual([]);
    expect(result.scannedFiles).toBe(0);
    expect(result.errors).toEqual(['LLM timeout']);
  });

  it('returns result with proposals count', async () => {
    const proposals = [makeProposal(), makeProposal({ title: 'Another fix' })];
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals,
      errors: [],
      scannedFiles: 20,
    });

    const result = await scoutRepo(makeDeps());

    expect(result.success).toBe(true);
    expect(result.proposals).toHaveLength(2);
    expect(result.scannedFiles).toBe(20);
  });
});

describe('approveProposals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates tickets from proposals', async () => {
    const proposals = [makeProposal(), makeProposal({ title: 'Security fix', category: 'security' })];
    const fakeTickets = proposals.map((p, i) => ({
      id: `tkt_${i}`,
      projectId: 'proj_abc123',
      title: p.title,
      description: 'desc',
      status: 'ready' as const,
      priority: p.confidence,
      shard: null,
      category: p.category,
      allowedPaths: p.allowed_paths,
      forbiddenPaths: [],
      verificationCommands: p.verification_commands,
      maxRetries: 3,
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    vi.mocked(tickets.createMany).mockResolvedValue(fakeTickets);

    const result = await approveProposals(makeDeps(), 'proj_abc123', proposals);

    expect(result).toHaveLength(2);
    expect(tickets.createMany).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ projectId: 'proj_abc123', title: 'Refactor utils module' }),
        expect.objectContaining({ projectId: 'proj_abc123', title: 'Security fix' }),
      ]),
    );
  });

  it('handles empty proposals array', async () => {
    vi.mocked(tickets.createMany).mockResolvedValue([]);

    const result = await approveProposals(makeDeps(), 'proj_abc123', []);

    expect(result).toHaveLength(0);
    expect(tickets.createMany).toHaveBeenCalledWith(expect.anything(), []);
  });

  it('links tickets to project', async () => {
    const proposal = makeProposal();
    vi.mocked(tickets.createMany).mockResolvedValue([{
      id: 'tkt_1',
      projectId: 'proj_xyz',
      title: proposal.title,
      description: '',
      status: 'ready',
      priority: 80,
      shard: null,
      category: 'refactor',
      allowedPaths: [],
      forbiddenPaths: [],
      verificationCommands: [],
      maxRetries: 3,
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }]);

    await approveProposals(makeDeps(), 'proj_xyz', [proposal]);

    expect(tickets.createMany).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ projectId: 'proj_xyz' }),
      ]),
    );
  });
});
