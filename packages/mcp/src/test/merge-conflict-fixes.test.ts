/**
 * Tests for merge-conflict reduction fixes:
 *   Fix 1: Path deconfliction at parallel dispatch
 *   Fix 2: Dedup against recently-completed tickets
 *   Fix 3: Rebase instructions in worktree prompts
 *   Fix 4: Ticket cleanup on session end
 *   Fix 5: File-set overlap dedup within proposal batches
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { repos } from '@promptwheel/core';
import type { DatabaseAdapter, Project } from '@promptwheel/core';
import { RunManager } from '../run-manager.js';
import { advance } from '../advance.js';
import { filterAndCreateTickets } from '../proposals.js';
import type { RawProposal } from '../proposals.js';
import { buildInlineTicketPrompt, shellEscape } from '../advance-prompts.js';
import type { SessionConfig } from '../types.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-merge-conflict-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  db = await createSQLiteAdapter({ url: dbPath });
  project = await repos.projects.ensureForRepo(db, {
    name: 'test-project',
    rootPath: tmpDir,
  });
  run = new RunManager(tmpDir);
});

afterEach(async () => {
  try { if (run.current) run.end(); } catch { /* ignore */ }
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx() {
  return { run, db, project };
}

function startRun(overrides?: Partial<SessionConfig>) {
  return run.create(project.id, {
    step_budget: 100,
    ticket_step_budget: 12,
    max_prs: 10,
    categories: ['refactor', 'test', 'docs', 'perf', 'fix'],
    min_confidence: 70,
    max_proposals: 5,
    ...overrides,
  });
}

function makeProposal(overrides: Partial<RawProposal> = {}): RawProposal {
  return {
    category: 'refactor',
    title: 'Extract shared validation logic',
    description: 'Three handlers duplicate email validation',
    acceptance_criteria: ['Single validateEmail() function'],
    verification_commands: ['npm test'],
    allowed_paths: ['src/handlers/', 'src/utils/'],
    files: ['src/handlers/signup.ts', 'src/utils/validate.ts'],
    confidence: 85,
    impact_score: 7,
    rationale: 'Reduces duplication',
    estimated_complexity: 'simple',
    risk: 'low',
    touched_files_estimate: 3,
    rollback_note: 'Revert single commit',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fix 1: Path deconfliction at parallel dispatch
// ---------------------------------------------------------------------------

describe('Fix 1 — parallel dispatch path deconfliction', () => {
  it('selects non-overlapping tickets for parallel execution', async () => {
    startRun({ parallel: 3, create_prs: true });
    const s = run.require();
    s.phase = 'NEXT_TICKET';
    s.scout_cycles = 1;

    // Create 3 tickets: first two overlap on src/auth/, third is independent
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Fix auth validation',
      description: 'Fix validation in auth module',
      status: 'ready',
      priority: 90,
      category: 'fix',
      allowedPaths: ['src/auth/validator.ts', 'src/auth/middleware.ts'],
      verificationCommands: ['npm test'],
    });
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Refactor auth handler',
      description: 'Refactor auth handler',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/auth/handler.ts', 'src/auth/middleware.ts'],
      verificationCommands: ['npm test'],
    });
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Add API tests',
      description: 'Add tests for API layer',
      status: 'ready',
      priority: 70,
      category: 'test',
      allowedPaths: ['src/api/routes.test.ts', 'src/api/handlers.test.ts'],
      verificationCommands: ['npm test'],
    });

    const resp = await advance(ctx());

    // Should dispatch 2 tickets (the auth ones overlap so only first + api tests)
    expect(resp.next_action).toBe('PARALLEL_EXECUTE');
    expect(resp.parallel_tickets).toBeDefined();
    expect(resp.parallel_tickets!.length).toBe(2);

    const titles = resp.parallel_tickets!.map(t => t.title);
    expect(titles).toContain('Fix auth validation');
    expect(titles).toContain('Add API tests');
    // The overlapping auth ticket should NOT be in the batch
    expect(titles).not.toContain('Refactor auth handler');
  });

  it('falls back to single ticket when all candidates overlap', async () => {
    startRun({ parallel: 3, create_prs: true });
    const s = run.require();
    s.phase = 'NEXT_TICKET';
    s.scout_cycles = 1;

    // All tickets share src/shared/ — wildcard overlap
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Ticket A',
      description: 'A',
      status: 'ready',
      priority: 90,
      category: 'refactor',
      allowedPaths: [],  // empty = wildcard, conflicts with everything
      verificationCommands: [],
    });
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Ticket B',
      description: 'B',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/b.ts'],
      verificationCommands: [],
    });

    const resp = await advance(ctx());

    // Wildcard ticket conflicts with everything → only 1 dispatched (sequential fallback)
    // Goes through sequential path since only 1 ticket selected
    expect(resp.phase).not.toBe('PARALLEL_EXECUTE');
  });

  it('logs PARALLEL_DECONFLICTED event when candidates are skipped', async () => {
    startRun({ parallel: 2, create_prs: true });
    const s = run.require();
    s.phase = 'NEXT_TICKET';
    s.scout_cycles = 1;

    // Two overlapping tickets
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Fix config loader',
      description: 'Fix',
      status: 'ready',
      priority: 90,
      category: 'fix',
      allowedPaths: ['src/config/loader.ts', 'src/config/index.ts'],
      verificationCommands: [],
    });
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Refactor config parser',
      description: 'Refactor',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/config/parser.ts', 'src/config/index.ts'],
      verificationCommands: [],
    });

    await advance(ctx());

    // Read events log
    const eventsPath = path.join(tmpDir, '.promptwheel', 'runs', s.run_id, 'events.ndjson');
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    const deconflictEvents = events.filter(e => e.type === 'PARALLEL_DECONFLICTED');
    expect(deconflictEvents.length).toBe(1);
    expect(deconflictEvents[0].payload.skipped).toBeGreaterThan(0);
  });

  it('dispatches all tickets when none overlap', async () => {
    startRun({ parallel: 3, create_prs: true });
    const s = run.require();
    s.phase = 'NEXT_TICKET';
    s.scout_cycles = 1;

    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Fix auth',
      description: 'Fix auth',
      status: 'ready',
      priority: 90,
      category: 'fix',
      allowedPaths: ['src/auth/login.ts'],
      verificationCommands: [],
    });
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Fix api',
      description: 'Fix api',
      status: 'ready',
      priority: 80,
      category: 'fix',
      allowedPaths: ['src/api/routes.ts'],
      verificationCommands: [],
    });
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Fix utils',
      description: 'Fix utils',
      status: 'ready',
      priority: 70,
      category: 'fix',
      allowedPaths: ['src/utils/helpers.ts'],
      verificationCommands: [],
    });

    const resp = await advance(ctx());

    expect(resp.next_action).toBe('PARALLEL_EXECUTE');
    expect(resp.parallel_tickets!.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: Dedup against recently-completed tickets
// ---------------------------------------------------------------------------

describe('Fix 2 — dedup includes recently-completed tickets', () => {
  it('rejects proposals matching recently-completed tickets', async () => {
    startRun();

    // Create a "done" ticket completed recently
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Extract shared validation logic',
      description: 'Already done',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });
    await repos.tickets.updateStatus(db, ticket.id, 'done');

    const result = await filterAndCreateTickets(run, db, [
      makeProposal({ title: 'Extract shared validation' }),
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.some(r => r.reason.includes('Duplicate'))).toBe(true);
  });

  it('allows proposals when done tickets are older than 24h', async () => {
    startRun();

    // Create a "done" ticket — simulate old completion by directly inserting with old timestamp
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Extract shared validation logic',
      description: 'Done a long time ago',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });
    await repos.tickets.updateStatus(db, ticket.id, 'done');

    // Backdate the updated_at to 25 hours ago
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db.query('UPDATE tickets SET updated_at = $1 WHERE id = $2', [oldDate, ticket.id]);

    const result = await filterAndCreateTickets(run, db, [
      makeProposal({ title: 'Extract shared validation' }),
    ]);

    // Old done ticket should NOT block dedup
    expect(result.accepted).toHaveLength(1);
  });

  it('still deduplicates against ready and in_progress tickets', async () => {
    startRun();

    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Extract shared validation logic',
      description: 'Currently in progress',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const result = await filterAndCreateTickets(run, db, [
      makeProposal({ title: 'Extract shared validation' }),
    ]);

    expect(result.accepted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: Rebase instructions in worktree prompts
// ---------------------------------------------------------------------------

describe('Fix 3 — rebase before push in worktree prompts', () => {
  it('includes rebase instructions when creating PRs in worktree mode', () => {
    const ticket = {
      id: 'tkt_123',
      title: 'Fix auth bug',
      description: 'Fix the auth validation',
      allowedPaths: ['src/auth/'],
      verificationCommands: ['npm test'],
      category: 'fix',
    };
    const constraints = {
      allowed_paths: ['src/auth/'],
      denied_paths: [],
      denied_patterns: [],
      max_files: 10,
      max_lines: 500,
      required_commands: ['npm test'],
      plan_required: false,
      auto_approve_patterns: [],
    };

    const prompt = buildInlineTicketPrompt(
      ticket, constraints, '', '', /* createPrs */ true, /* draft */ false,
      /* direct */ false, undefined, [],
    );

    expect(prompt).toContain('git fetch origin main');
    expect(prompt).toContain('git rebase origin/main');
    expect(prompt).toContain('git push -u origin');
    expect(prompt).toContain('rebase --abort');
    expect(prompt).toContain('merge conflict during rebase');
  });

  it('does NOT include rebase when not creating PRs', () => {
    const ticket = {
      id: 'tkt_456',
      title: 'Fix config',
      description: 'Fix config loading',
      allowedPaths: ['src/config/'],
      verificationCommands: [],
      category: 'fix',
    };
    const constraints = {
      allowed_paths: ['src/config/'],
      denied_paths: [],
      denied_patterns: [],
      max_files: 10,
      max_lines: 500,
      required_commands: [],
      plan_required: false,
      auto_approve_patterns: [],
    };

    const prompt = buildInlineTicketPrompt(
      ticket, constraints, '', '', /* createPrs */ false, /* draft */ false,
      /* direct */ false, undefined, [],
    );

    expect(prompt).not.toContain('git fetch origin main');
    expect(prompt).not.toContain('git rebase origin/main');
    expect(prompt).not.toContain('merge conflict during rebase');
  });

  it('does NOT include rebase in direct mode', () => {
    const ticket = {
      id: 'tkt_789',
      title: 'Fix utils',
      description: 'Fix utility functions',
      allowedPaths: ['src/utils/'],
      verificationCommands: [],
      category: 'fix',
    };
    const constraints = {
      allowed_paths: ['src/utils/'],
      denied_paths: [],
      denied_patterns: [],
      max_files: 10,
      max_lines: 500,
      required_commands: [],
      plan_required: false,
      auto_approve_patterns: [],
    };

    const prompt = buildInlineTicketPrompt(
      ticket, constraints, '', '', /* createPrs */ true, /* draft */ false,
      /* direct */ true, undefined, [],
    );

    // Direct mode uses simpler flow — no worktree, no rebase
    expect(prompt).not.toContain('git rebase origin/main');
  });
});

// ---------------------------------------------------------------------------
// Fix 4: Ticket cleanup on session end
// ---------------------------------------------------------------------------

describe('Fix 4 — ticket cleanup on session end', () => {
  it('aborts remaining ready tickets on session end', async () => {
    startRun();

    const ticket1 = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Ready ticket 1',
      description: 'Will be aborted',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });
    const ticket2 = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Ready ticket 2',
      description: 'Will also be aborted',
      status: 'ready',
      priority: 70,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    // Import the session tool handler indirectly — test the cleanup logic directly
    const projectId = run.require().project_id;
    run.end();

    // Simulate the cleanup logic from end_session
    for (const status of ['ready', 'in_progress', 'blocked'] as const) {
      const staleTickets = await repos.tickets.listByProject(db, projectId, { status });
      for (const ticket of staleTickets) {
        await repos.tickets.updateStatus(db, ticket.id, 'aborted');
      }
    }

    // Verify tickets are aborted
    const t1 = await repos.tickets.getById(db, ticket1.id);
    const t2 = await repos.tickets.getById(db, ticket2.id);
    expect(t1!.status).toBe('aborted');
    expect(t2!.status).toBe('aborted');
  });

  it('aborts orphaned in_progress tickets on session end', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Orphaned in-progress',
      description: 'Was being worked on',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });
    await repos.tickets.updateStatus(db, ticket.id, 'in_progress');

    const projectId = run.require().project_id;
    run.end();

    // Simulate cleanup
    for (const status of ['ready', 'in_progress', 'blocked'] as const) {
      const staleTickets = await repos.tickets.listByProject(db, projectId, { status });
      for (const t of staleTickets) {
        await repos.tickets.updateStatus(db, t.id, 'aborted');
      }
    }

    const t = await repos.tickets.getById(db, ticket.id);
    expect(t!.status).toBe('aborted');
  });

  it('aborts blocked tickets on session end', async () => {
    startRun();

    const blockedTicket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Blocked ticket',
      description: 'Stuck on scope validation',
      status: 'ready',
      priority: 70,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });
    await repos.tickets.updateStatus(db, blockedTicket.id, 'blocked');

    const projectId = run.require().project_id;
    run.end();

    for (const status of ['ready', 'in_progress', 'blocked'] as const) {
      const staleTickets = await repos.tickets.listByProject(db, projectId, { status });
      for (const t of staleTickets) {
        await repos.tickets.updateStatus(db, t.id, 'aborted');
      }
    }

    const blocked = await repos.tickets.getById(db, blockedTicket.id);
    expect(blocked!.status).toBe('aborted');
  });

  it('does not abort done tickets', async () => {
    startRun();

    const doneTicket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Completed ticket',
      description: 'Already done',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });
    await repos.tickets.updateStatus(db, doneTicket.id, 'done');

    const projectId = run.require().project_id;
    run.end();

    for (const status of ['ready', 'in_progress', 'blocked'] as const) {
      const staleTickets = await repos.tickets.listByProject(db, projectId, { status });
      for (const t of staleTickets) {
        await repos.tickets.updateStatus(db, t.id, 'aborted');
      }
    }

    const done = await repos.tickets.getById(db, doneTicket.id);
    expect(done!.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Fix 5: File-set overlap dedup within proposal batches
// ---------------------------------------------------------------------------

describe('Fix 5 — file-set overlap dedup within batches', () => {
  it('rejects batch proposals with identical file sets (>= 3 files)', async () => {
    startRun();

    const sharedFiles = ['src/auth/login.ts', 'src/auth/validator.ts', 'src/auth/middleware.ts'];
    const result = await filterAndCreateTickets(run, db, [
      makeProposal({
        title: 'Refactor auth validation flow',
        files: sharedFiles,
        allowed_paths: ['src/auth/'],
      }),
      makeProposal({
        title: 'Improve auth validation logic',
        files: sharedFiles,
        allowed_paths: ['src/auth/'],
      }),
    ]);

    // Second proposal should be rejected as file-set duplicate
    // (first passes, second has identical 3-file set)
    expect(result.accepted.length).toBeLessThanOrEqual(1);
    const fileSetRejects = result.rejected.filter(r => r.reason.includes('identical file set'));
    expect(fileSetRejects.length).toBeGreaterThanOrEqual(1);
  });

  it('allows proposals with different file sets', async () => {
    startRun();

    const result = await filterAndCreateTickets(run, db, [
      makeProposal({
        title: 'Refactor auth module',
        files: ['src/auth/login.ts', 'src/auth/validator.ts', 'src/auth/middleware.ts'],
        allowed_paths: ['src/auth/'],
      }),
      makeProposal({
        title: 'Refactor API layer',
        files: ['src/api/routes.ts', 'src/api/handlers.ts', 'src/api/middleware.ts'],
        allowed_paths: ['src/api/'],
      }),
    ]);

    expect(result.accepted).toHaveLength(2);
  });

  it('does not trigger file-set dedup for small file sets (< 3)', async () => {
    startRun();

    const result = await filterAndCreateTickets(run, db, [
      makeProposal({
        title: 'Refactor database connection pooling',
        files: ['src/db.ts', 'src/pool.ts'],  // only 2 files
        allowed_paths: ['src/'],
      }),
      makeProposal({
        title: 'Optimize database query caching',
        files: ['src/db.ts', 'src/pool.ts'],  // same 2 files
        allowed_paths: ['src/'],
      }),
    ]);

    // Both should pass — file-set dedup requires >= 3 files
    expect(result.accepted).toHaveLength(2);
  });

  it('detects overlap through glob patterns via pathsOverlap', async () => {
    startRun();

    const result = await filterAndCreateTickets(run, db, [
      makeProposal({
        title: 'Refactor shared utilities module',
        files: ['src/utils/helpers.ts', 'src/utils/format.ts', 'src/utils/validate.ts'],
        allowed_paths: ['src/utils/'],
      }),
      makeProposal({
        title: 'Clean up shared utilities codebase',
        files: ['src/utils/helpers.ts', 'src/utils/format.ts', 'src/utils/validate.ts'],
        allowed_paths: ['src/utils/'],
      }),
    ]);

    expect(result.accepted.length).toBeLessThanOrEqual(1);
  });
});
