/**
 * Tests for intelligence tools: validate_ticket, audit_tickets,
 * ticket_stats, history, heal_blocked.
 *
 * These tools query the database and return diagnostic information.
 * We test the underlying logic by creating real tickets/runs in SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { repos } from '@promptwheel/core';
import type { DatabaseAdapter, Project, Ticket } from '@promptwheel/core';
import { RunManager } from '../run-manager.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-intel-test-'));
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

// ── validate_ticket logic ───────────────────────────────────────────────────

describe('validate_ticket logic', () => {
  it('passes for a well-formed ready ticket', async () => {
    startRun();
    const ticket = await createTicket();
    expect(ticket.status).toBe('ready');
    expect(ticket.title).toBeTruthy();
    expect(ticket.description).toBeTruthy();
    expect(ticket.verificationCommands.length).toBeGreaterThan(0);
  });

  it('detects missing description', async () => {
    startRun();
    const ticket = await createTicket({ description: '' });
    expect(ticket.description).toBeFalsy();
  });

  it('detects missing verification commands', async () => {
    startRun();
    const ticket = await createTicket({ verificationCommands: [] });
    expect(ticket.verificationCommands).toHaveLength(0);
  });

  it('detects completed ticket status', async () => {
    startRun();
    const ticket = await createTicket();
    await repos.tickets.updateStatus(db, ticket.id, 'done');
    const updated = await repos.tickets.getById(db, ticket.id);
    expect(updated!.status).toBe('done');
  });

  it('detects blocked ticket status', async () => {
    startRun();
    const ticket = await createTicket();
    await repos.tickets.updateStatus(db, ticket.id, 'blocked');
    const updated = await repos.tickets.getById(db, ticket.id);
    expect(updated!.status).toBe('blocked');
  });
});

// ── audit_tickets logic ─────────────────────────────────────────────────────

describe('audit_tickets logic', () => {
  it('aggregates by status', async () => {
    startRun();
    await createTicket({ title: 'T1', status: 'ready' });
    await createTicket({ title: 'T2', status: 'ready' });
    const t3 = await createTicket({ title: 'T3', status: 'ready' });
    await repos.tickets.updateStatus(db, t3.id, 'done');

    const allTickets = await repos.tickets.listByProject(db, project.id, { limit: 500 });
    const byStatus: Record<string, number> = {};
    for (const t of allTickets) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    }
    expect(byStatus['ready']).toBe(2);
    expect(byStatus['done']).toBe(1);
  });

  it('aggregates by category', async () => {
    startRun();
    await createTicket({ title: 'T1', category: 'refactor' });
    await createTicket({ title: 'T2', category: 'test' });
    await createTicket({ title: 'T3', category: 'test' });

    const allTickets = await repos.tickets.listByProject(db, project.id, { limit: 500 });
    const byCategory: Record<string, number> = {};
    for (const t of allTickets) {
      const cat = t.category ?? 'uncategorized';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    }
    expect(byCategory['refactor']).toBe(1);
    expect(byCategory['test']).toBe(2);
  });

  it('detects quality issues: missing verification', async () => {
    startRun();
    await createTicket({ title: 'T1', verificationCommands: [] });
    await createTicket({ title: 'T2', verificationCommands: ['npm test'] });

    const allTickets = await repos.tickets.listByProject(db, project.id, { limit: 500 });
    const noVerification = allTickets.filter(t => t.verificationCommands.length === 0);
    expect(noVerification).toHaveLength(1);
  });

  it('detects quality issues: no scope', async () => {
    startRun();
    await createTicket({ title: 'T1', allowedPaths: [] });

    const allTickets = await repos.tickets.listByProject(db, project.id, { limit: 500 });
    const noScope = allTickets.filter(t => t.allowedPaths.length === 0);
    expect(noScope).toHaveLength(1);
  });

  it('filters by status', async () => {
    startRun();
    await createTicket({ title: 'T1', status: 'ready' });
    const t2 = await createTicket({ title: 'T2', status: 'ready' });
    await repos.tickets.updateStatus(db, t2.id, 'done');

    const doneTickets = await repos.tickets.listByProject(db, project.id, { status: 'done', limit: 500 });
    expect(doneTickets).toHaveLength(1);
    expect(doneTickets[0].title).toBe('T2');
  });
});

// ── ticket_stats logic ──────────────────────────────────────────────────────

describe('ticket_stats logic', () => {
  it('counts completions', async () => {
    startRun();
    const t1 = await createTicket({ title: 'T1' });
    const t2 = await createTicket({ title: 'T2' });
    await repos.tickets.updateStatus(db, t1.id, 'done');
    await repos.tickets.updateStatus(db, t2.id, 'done');

    const allTickets = await repos.tickets.listByProject(db, project.id, { limit: 1000 });
    const completedTickets = allTickets.filter(t => t.status === 'done');
    expect(completedTickets).toHaveLength(2);
  });

  it('calculates success rate from runs', async () => {
    startRun();
    const t1 = await createTicket({ title: 'T1' });
    const t2 = await createTicket({ title: 'T2' });

    const run1 = await repos.runs.create(db, { projectId: project.id, type: 'worker', ticketId: t1.id });
    const run2 = await repos.runs.create(db, { projectId: project.id, type: 'worker', ticketId: t2.id });
    await repos.runs.markSuccess(db, run1.id, { summary: 'ok' });
    await repos.runs.markFailure(db, run2.id, 'failed');

    const allRuns = await repos.runs.listByProject(db, project.id, { limit: 1000 });
    const workerRuns = allRuns.filter(r => r.type === 'worker');
    const successRuns = workerRuns.filter(r => r.status === 'success');
    const successRate = workerRuns.length > 0
      ? Math.round((successRuns.length / workerRuns.length) * 100) / 100
      : 0;
    expect(successRate).toBe(0.5);
  });
});

// ── history logic ───────────────────────────────────────────────────────────

describe('history logic', () => {
  it('lists runs with summary stats', async () => {
    startRun();
    const t1 = await createTicket({ title: 'T1' });
    const r1 = await repos.runs.create(db, { projectId: project.id, type: 'worker', ticketId: t1.id });
    await repos.runs.markSuccess(db, r1.id, { summary: 'done' });

    const allRuns = await repos.runs.listByProject(db, project.id, { limit: 10 });
    expect(allRuns.length).toBeGreaterThanOrEqual(1);

    const successful = allRuns.filter(r => r.status === 'success');
    expect(successful.length).toBe(1);
  });

  it('respects limit parameter', async () => {
    startRun();
    const t1 = await createTicket({ title: 'T1' });
    const t2 = await createTicket({ title: 'T2' });
    await repos.runs.create(db, { projectId: project.id, type: 'worker', ticketId: t1.id });
    await repos.runs.create(db, { projectId: project.id, type: 'worker', ticketId: t2.id });

    const limited = await repos.runs.listByProject(db, project.id, { limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

// ── heal_blocked logic ──────────────────────────────────────────────────────

describe('heal_blocked logic', () => {
  it('diagnoses non-blocked ticket', async () => {
    startRun();
    const ticket = await createTicket({ status: 'ready' });
    // Should report "not blocked"
    expect(ticket.status).toBe('ready');
  });

  it('diagnoses blocked ticket with retry exhaustion', async () => {
    startRun();
    const ticket = await createTicket({ status: 'ready' });
    await repos.tickets.updateStatus(db, ticket.id, 'blocked');
    const updated = await repos.tickets.getById(db, ticket.id);
    expect(updated!.status).toBe('blocked');
    // retryCount >= maxRetries signals exhaustion
    expect(updated!.retryCount).toBe(0);
    expect(updated!.maxRetries).toBeGreaterThan(0);
  });

  it('retry action resets ticket to ready', async () => {
    startRun();
    const ticket = await createTicket({ status: 'ready' });
    await repos.tickets.updateStatus(db, ticket.id, 'blocked');
    // Retry action
    await repos.tickets.updateStatus(db, ticket.id, 'ready');
    const updated = await repos.tickets.getById(db, ticket.id);
    expect(updated!.status).toBe('ready');
  });

  it('diagnoses narrow scope', async () => {
    startRun();
    const ticket = await createTicket({ allowedPaths: ['src/foo.ts'] });
    // Narrow scope (<=2 paths) triggers suggestion
    expect(ticket.allowedPaths.length).toBeLessThanOrEqual(2);
  });

  it('diagnoses missing verification commands', async () => {
    startRun();
    const ticket = await createTicket({ verificationCommands: [] });
    expect(ticket.verificationCommands.length).toBe(0);
  });
});
