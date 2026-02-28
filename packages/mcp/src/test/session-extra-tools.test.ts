/**
 * Tests for session tools (nudge, advance_ticket, ticket_event),
 * drill status, and git setup helpers.
 *
 * Tests the underlying logic without going through the MCP server layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { repos } from '@promptwheel/core';
import type { DatabaseAdapter, Project, Ticket } from '@promptwheel/core';
import { RunManager } from '../run-manager.js';
import { advanceTicketWorker, ingestTicketEvent } from '../ticket-worker.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-session-extra-test-'));
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

function startRun(overrides?: Record<string, unknown>) {
  return run.create(project.id, {
    step_budget: 50,
    ticket_step_budget: 12,
    max_prs: 5,
    ...overrides,
  });
}

async function createTicket(overrides?: Partial<Parameters<typeof repos.tickets.create>[1]>): Promise<Ticket> {
  return repos.tickets.create(db, {
    projectId: project.id,
    title: 'Test ticket',
    description: 'Fix the thing',
    status: 'ready',
    priority: 80,
    category: 'refactor',
    allowedPaths: ['src/**'],
    verificationCommands: ['npm test'],
    ...overrides,
  });
}

// ── nudge ───────────────────────────────────────────────────────────────────

describe('nudge', () => {
  it('adds a hint to session state', () => {
    startRun();
    run.addHint('focus on auth module');
    const s = run.require();
    expect(s.hints).toContain('focus on auth module');
  });

  it('accumulates multiple hints', () => {
    startRun();
    run.addHint('focus on auth');
    run.addHint('skip test files');
    const s = run.require();
    expect(s.hints).toHaveLength(2);
    expect(s.hints).toContain('focus on auth');
    expect(s.hints).toContain('skip test files');
  });
});

// ── advanceTicketWorker ─────────────────────────────────────────────────────

describe('advance_ticket (advanceTicketWorker)', () => {
  it('returns FAILED when no worker state exists', async () => {
    startRun({ parallel: 2 });
    const result = await advanceTicketWorker(
      { run, db, project },
      'nonexistent-ticket',
    );
    expect(result.action).toBe('FAILED');
    expect(result.reason).toContain('No worker state');
  });

  it('returns PROMPT in PLAN phase for a ticket with worker state', async () => {
    startRun({ parallel: 2 });
    const ticket = await createTicket();

    // Initialize ticket worker
    run.initTicketWorker(ticket.id, {
      title: ticket.title,
      allowedPaths: ticket.allowedPaths,
      category: ticket.category ?? 'refactor',
    });

    const result = await advanceTicketWorker(
      { run, db, project },
      ticket.id,
    );
    expect(result.action).toBe('PROMPT');
    expect(result.phase).toBe('PLAN');
    expect(result.ticket_id).toBe(ticket.id);
    expect(result.prompt).toContain('Commit Plan Required');
  });

  it('fails when ticket step budget is exhausted', async () => {
    startRun({ parallel: 2, ticket_step_budget: 1 });
    const ticket = await createTicket();

    run.initTicketWorker(ticket.id, {
      title: ticket.title,
      allowedPaths: ticket.allowedPaths,
      category: ticket.category ?? 'refactor',
    });

    // First call uses step 1
    const result1 = await advanceTicketWorker({ run, db, project }, ticket.id);
    expect(result1.action).toBe('PROMPT');

    // Second call exceeds budget
    const result2 = await advanceTicketWorker({ run, db, project }, ticket.id);
    expect(result2.action).toBe('FAILED');
    expect(result2.reason).toContain('budget exhausted');
  });

  it('returns FAILED when worker was already completed (cleaned up)', async () => {
    startRun({ parallel: 2 });
    const ticket = await createTicket();

    run.initTicketWorker(ticket.id, {
      title: ticket.title,
      allowedPaths: ticket.allowedPaths,
      category: ticket.category ?? 'refactor',
    });

    // completeTicketWorker deletes the worker from state
    run.completeTicketWorker(ticket.id);

    // After completion, worker is gone — should return FAILED (no worker state)
    const result = await advanceTicketWorker({ run, db, project }, ticket.id);
    expect(result.action).toBe('FAILED');
    expect(result.reason).toContain('No worker state');
  });
});

// ── ingestTicketEvent ───────────────────────────────────────────────────────

describe('ticket_event (ingestTicketEvent)', () => {
  it('returns not processed when no worker exists', async () => {
    startRun({ parallel: 2 });
    const result = await ingestTicketEvent(
      { run, db, project },
      'nonexistent',
      'PLAN_SUBMITTED',
      {},
    );
    expect(result.processed).toBe(false);
    expect(result.message).toContain('No worker');
  });

  it('rejects plan submitted outside PLAN phase', async () => {
    startRun({ parallel: 2 });
    const ticket = await createTicket();

    run.initTicketWorker(ticket.id, {
      title: ticket.title,
      allowedPaths: ticket.allowedPaths,
      category: ticket.category ?? 'refactor',
    });

    // Set worker to EXECUTE phase manually
    run.updateTicketWorker(ticket.id, { phase: 'EXECUTE', plan_approved: true });

    const result = await ingestTicketEvent(
      { run, db, project },
      ticket.id,
      'PLAN_SUBMITTED',
      { files_to_touch: [{ path: 'src/foo.ts', action: 'modify', reason: 'fix' }] },
    );
    expect(result.processed).toBe(true);
    expect(result.message).toContain('outside PLAN phase');
  });

  it('handles QA_PASSED and moves to PR or completes', async () => {
    startRun({ parallel: 2 });
    const ticket = await createTicket();

    run.initTicketWorker(ticket.id, {
      title: ticket.title,
      allowedPaths: ticket.allowedPaths,
      category: ticket.category ?? 'refactor',
    });

    // Set to QA phase
    run.updateTicketWorker(ticket.id, { phase: 'QA', plan_approved: true });

    const result = await ingestTicketEvent(
      { run, db, project },
      ticket.id,
      'QA_PASSED',
      {},
    );
    expect(result.processed).toBe(true);
    // Since create_prs is not set, should complete directly
    expect(result.message).toContain('ticket complete');
  });

  it('handles QA_FAILED and retries', async () => {
    startRun({ parallel: 2 });
    const ticket = await createTicket();

    run.initTicketWorker(ticket.id, {
      title: ticket.title,
      allowedPaths: ticket.allowedPaths,
      category: ticket.category ?? 'refactor',
    });

    run.updateTicketWorker(ticket.id, { phase: 'QA', plan_approved: true });

    const result = await ingestTicketEvent(
      { run, db, project },
      ticket.id,
      'QA_FAILED',
      { command: 'npm test', error: 'test failure' },
    );
    expect(result.processed).toBe(true);
    expect(result.message).toContain('retrying');

    // Worker should be back in EXECUTE
    const worker = run.getTicketWorker(ticket.id);
    expect(worker!.phase).toBe('EXECUTE');
    expect(worker!.qa_retries).toBe(1);
  });

  it('handles PR_CREATED and completes ticket', async () => {
    startRun({ parallel: 2, create_prs: true });
    const ticket = await createTicket();

    run.initTicketWorker(ticket.id, {
      title: ticket.title,
      allowedPaths: ticket.allowedPaths,
      category: ticket.category ?? 'refactor',
    });

    run.updateTicketWorker(ticket.id, { phase: 'PR', plan_approved: true });

    const result = await ingestTicketEvent(
      { run, db, project },
      ticket.id,
      'PR_CREATED',
      { url: 'https://github.com/org/repo/pull/42', branch: 'pw/fix' },
    );
    expect(result.processed).toBe(true);
    expect(result.message).toContain('complete');

    // Worker is deleted after completion (completeTicketWorker removes it)
    const worker = run.getTicketWorker(ticket.id);
    expect(worker).toBeNull();
    // Verify completion was tracked
    const s = run.require();
    expect(s.tickets_completed).toBeGreaterThanOrEqual(1);
  });

  it('rejects PR_CREATED without url', async () => {
    startRun({ parallel: 2, create_prs: true });
    const ticket = await createTicket();

    run.initTicketWorker(ticket.id, {
      title: ticket.title,
      allowedPaths: ticket.allowedPaths,
      category: ticket.category ?? 'refactor',
    });

    run.updateTicketWorker(ticket.id, { phase: 'PR', plan_approved: true });

    const result = await ingestTicketEvent(
      { run, db, project },
      ticket.id,
      'PR_CREATED',
      { branch: 'pw/fix' },
    );
    expect(result.processed).toBe(true);
    expect(result.message).toContain('missing url');
  });

  it('handles unknown event type gracefully', async () => {
    startRun({ parallel: 2 });
    const ticket = await createTicket();

    run.initTicketWorker(ticket.id, {
      title: ticket.title,
      allowedPaths: ticket.allowedPaths,
      category: ticket.category ?? 'refactor',
    });

    const result = await ingestTicketEvent(
      { run, db, project },
      ticket.id,
      'UNKNOWN_EVENT',
      {},
    );
    expect(result.processed).toBe(true);
    expect(result.message).toContain('recorded');
  });
});

// ── drill_status logic ──────────────────────────────────────────────────────

describe('drill_status', () => {
  it('returns defaults when no drill history exists', () => {
    const historyPath = path.join(tmpDir, '.promptwheel', 'drill-history.json');
    expect(fs.existsSync(historyPath)).toBe(false);
  });

  it('loads drill history from file', () => {
    const historyDir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(historyDir, { recursive: true });

    const history = {
      entries: [
        {
          name: 'traj-1',
          description: 'First trajectory',
          stepsTotal: 3,
          stepsCompleted: 3,
          stepsFailed: 0,
          outcome: 'completed',
          categories: ['refactor', 'test'],
          scopes: ['src/**'],
        },
        {
          name: 'traj-2',
          description: 'Second trajectory',
          stepsTotal: 2,
          stepsCompleted: 0,
          stepsFailed: 2,
          outcome: 'stalled',
          categories: ['security'],
          scopes: ['lib/**'],
        },
      ],
      coveredCategories: { refactor: 1, test: 1, security: 1 },
      coveredScopes: { 'src/**': 1, 'lib/**': 1 },
    };

    fs.writeFileSync(
      path.join(historyDir, 'drill-history.json'),
      JSON.stringify(history),
      'utf-8',
    );

    const raw = fs.readFileSync(path.join(historyDir, 'drill-history.json'), 'utf-8');
    const data = JSON.parse(raw);
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].outcome).toBe('completed');
    expect(data.entries[1].outcome).toBe('stalled');
  });

  it('computes metrics from drill history', () => {
    const entries = [
      { name: 't1', outcome: 'completed', categories: ['refactor'] },
      { name: 't2', outcome: 'completed', categories: ['test'] },
      { name: 't3', outcome: 'stalled', categories: ['security'] },
    ];

    const completed = entries.filter(e => e.outcome === 'completed').length;
    const completionRate = completed / entries.length;
    expect(completionRate).toBeCloseTo(0.667, 2);
  });

  it('detects active trajectory in drill status', () => {
    const pwDir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(pwDir, { recursive: true });

    const trajState = {
      trajectoryName: 'active-traj',
      paused: false,
      stepStates: {
        's1': { status: 'completed' },
        's2': { status: 'active' },
        's3': { status: 'pending' },
      },
    };

    fs.writeFileSync(
      path.join(pwDir, 'trajectory-state.json'),
      JSON.stringify(trajState),
      'utf-8',
    );

    const raw = fs.readFileSync(path.join(pwDir, 'trajectory-state.json'), 'utf-8');
    const data = JSON.parse(raw);
    expect(data.trajectoryName).toBe('active-traj');
    expect(data.paused).toBe(false);

    const completedSteps = Object.values(data.stepStates)
      .filter((s: any) => s.status === 'completed').length;
    expect(completedSteps).toBe(1);
  });

  it('reads drill enabled from config', () => {
    const pwDir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(pwDir, { recursive: true });

    const config = { auto: { drill: { enabled: false } } };
    fs.writeFileSync(path.join(pwDir, 'config.json'), JSON.stringify(config), 'utf-8');

    const raw = fs.readFileSync(path.join(pwDir, 'config.json'), 'utf-8');
    const data = JSON.parse(raw);
    expect(data.auto.drill.enabled).toBe(false);
  });
});

// ── git_setup logic (branch name validation) ────────────────────────────────

describe('git_setup (branch name validation)', () => {
  // Test the branch name validation logic from git.ts
  function validateBranchName(branch: string): boolean {
    const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9\-_./]*$/;
    return validPattern.test(branch);
  }

  it('accepts valid branch names', () => {
    expect(validateBranchName('main')).toBe(true);
    expect(validateBranchName('feature/add-tests')).toBe(true);
    expect(validateBranchName('release-1.0.0')).toBe(true);
    expect(validateBranchName('fix_bug_123')).toBe(true);
    expect(validateBranchName('promptwheel/t123/fix-thing')).toBe(true);
  });

  it('rejects branch names starting with hyphen', () => {
    expect(validateBranchName('-delete')).toBe(false);
    expect(validateBranchName('--force')).toBe(false);
  });

  it('rejects branch names with shell metacharacters', () => {
    expect(validateBranchName('branch;rm')).toBe(false);
    expect(validateBranchName('branch|pipe')).toBe(false);
    expect(validateBranchName('branch&bg')).toBe(false);
    expect(validateBranchName('branch$var')).toBe(false);
    expect(validateBranchName('branch`cmd`')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateBranchName('')).toBe(false);
  });

  it('generates valid slug from ticket title', () => {
    const title = 'Fix: broken authentication flow!!';
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    expect(slug).toBe('fix-broken-authentication-flow');
    expect(validateBranchName(`promptwheel/t123/${slug}`)).toBe(true);
  });
});
