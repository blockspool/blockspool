/**
 * Tests for scope policy derivation, plan validation, and file checking (Phase 4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@blockspool/sqlite';
import { repos } from '@blockspool/core';
import type { DatabaseAdapter, Project } from '@blockspool/core';
import { RunManager } from '../run-manager.js';
import { processEvent } from '../event-processor.js';
import { advance } from '../advance.js';
import {
  deriveScopePolicy,
  validatePlanScope,
  isFileAllowed,
  containsCredentials,
  serializeScopePolicy,
} from '../scope-policy.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-scope-test-'));
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
    step_budget: 100,
    ticket_step_budget: 12,
    max_prs: 5,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// deriveScopePolicy
// ---------------------------------------------------------------------------

describe('deriveScopePolicy', () => {
  it('returns correct defaults for refactor category', () => {
    const policy = deriveScopePolicy({
      allowedPaths: ['src/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
    });

    expect(policy.allowed_paths).toEqual(['src/**']);
    expect(policy.denied_paths).toContain('.env');
    expect(policy.denied_paths).toContain('node_modules/**');
    expect(policy.max_files).toBe(10);
    expect(policy.max_lines).toBe(500);
    expect(policy.plan_required).toBe(true);
  });

  it('allows 1000 lines for test category', () => {
    const policy = deriveScopePolicy({
      allowedPaths: [],
      category: 'test',
      maxLinesPerTicket: 500,
    });

    expect(policy.max_lines).toBe(1000);
  });

  it('skips plan for docs category', () => {
    const policy = deriveScopePolicy({
      allowedPaths: [],
      category: 'docs',
      maxLinesPerTicket: 500,
    });

    expect(policy.plan_required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validatePlanScope
// ---------------------------------------------------------------------------

describe('validatePlanScope', () => {
  const defaultPolicy = deriveScopePolicy({
    allowedPaths: ['src/**'],
    category: 'refactor',
    maxLinesPerTicket: 500,
  });

  it('accepts valid plan within scope', () => {
    const result = validatePlanScope(
      [{ path: 'src/foo.ts', action: 'modify', reason: 'fix bug' }],
      10, 'low', defaultPolicy,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects plan with no files', () => {
    const result = validatePlanScope([], 10, 'low', defaultPolicy);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('at least one file');
  });

  it('rejects plan exceeding line limit', () => {
    const result = validatePlanScope(
      [{ path: 'src/foo.ts', action: 'modify', reason: 'big' }],
      9999, 'low', defaultPolicy,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Estimated lines');
  });

  it('rejects plan exceeding file limit', () => {
    const files = Array.from({ length: 11 }, (_, i) => ({
      path: `src/file${i}.ts`, action: 'modify', reason: 'change',
    }));
    const result = validatePlanScope(files, 10, 'low', defaultPolicy);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('max allowed is 10');
  });

  it('rejects plan with invalid risk level', () => {
    const result = validatePlanScope(
      [{ path: 'src/foo.ts', action: 'modify', reason: 'fix' }],
      10, 'extreme', defaultPolicy,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('risk_level');
  });

  it('rejects plan touching denied path (.env)', () => {
    const result = validatePlanScope(
      [{ path: '.env', action: 'modify', reason: 'add key' }],
      5, 'low', defaultPolicy,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('denied path');
  });

  it('rejects plan touching node_modules', () => {
    const result = validatePlanScope(
      [{ path: 'node_modules/foo/index.js', action: 'modify', reason: 'patch' }],
      5, 'low', defaultPolicy,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('denied path');
  });

  it('rejects plan touching sensitive file (.pem)', () => {
    const result = validatePlanScope(
      [{ path: 'certs/server.pem', action: 'modify', reason: 'rotate' }],
      5, 'low', defaultPolicy,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('sensitive file');
  });

  it('rejects plan touching file outside allowed_paths', () => {
    const result = validatePlanScope(
      [{ path: 'config/settings.json', action: 'modify', reason: 'update' }],
      5, 'low', defaultPolicy,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('outside allowed paths');
  });

  it('allows any path when allowed_paths is empty', () => {
    const openPolicy = deriveScopePolicy({
      allowedPaths: [],
      category: 'refactor',
      maxLinesPerTicket: 500,
    });
    const result = validatePlanScope(
      [{ path: 'config/settings.json', action: 'modify', reason: 'update' }],
      5, 'low', openPolicy,
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isFileAllowed
// ---------------------------------------------------------------------------

describe('isFileAllowed', () => {
  const policy = deriveScopePolicy({
    allowedPaths: ['src/**'],
    category: 'refactor',
    maxLinesPerTicket: 500,
  });

  it('allows files within scope', () => {
    expect(isFileAllowed('src/utils/helper.ts', policy)).toBe(true);
  });

  it('denies files outside scope', () => {
    expect(isFileAllowed('config/app.json', policy)).toBe(false);
  });

  it('denies .env files', () => {
    expect(isFileAllowed('.env', policy)).toBe(false);
  });

  it('denies node_modules', () => {
    expect(isFileAllowed('node_modules/foo/bar.js', policy)).toBe(false);
  });

  it('denies .key files', () => {
    expect(isFileAllowed('certs/private.key', policy)).toBe(false);
  });

  it('denies files with credentials in name', () => {
    expect(isFileAllowed('src/credentials.json', policy)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// containsCredentials
// ---------------------------------------------------------------------------

describe('containsCredentials', () => {
  it('detects AWS access key', () => {
    expect(containsCredentials('const key = "AKIAIOSFODNN7EXAMPLE"')).not.toBeNull();
  });

  it('detects PEM key', () => {
    expect(containsCredentials('-----BEGIN RSA PRIVATE KEY-----')).not.toBeNull();
  });

  it('detects GitHub PAT', () => {
    expect(containsCredentials('token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"')).not.toBeNull();
  });

  it('detects OpenAI key', () => {
    expect(containsCredentials('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv')).not.toBeNull();
  });

  it('detects hardcoded password', () => {
    expect(containsCredentials('password = "mySecret123"')).not.toBeNull();
  });

  it('returns null for clean code', () => {
    expect(containsCredentials('const x = 42;\nfunction foo() { return x; }')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializeScopePolicy
// ---------------------------------------------------------------------------

describe('serializeScopePolicy', () => {
  it('converts RegExp to strings', () => {
    const policy = deriveScopePolicy({
      allowedPaths: ['src/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
    });
    const serialized = serializeScopePolicy(policy);
    expect(Array.isArray(serialized.denied_patterns)).toBe(true);
    expect(typeof (serialized.denied_patterns as string[])[0]).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Event processor: PLAN_SUBMITTED with scope enforcement
// ---------------------------------------------------------------------------

describe('processEvent PLAN_SUBMITTED — scope enforcement', () => {
  it('rejects plan touching file outside allowed_paths', async () => {
    startRun();
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Scoped ticket',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = ticket.id;

    const result = await processEvent(run, db, 'PLAN_SUBMITTED', {
      ticket_id: ticket.id,
      files_to_touch: [{ path: 'config/app.json', action: 'modify', reason: 'update config' }],
      expected_tests: [],
      estimated_lines: 10,
      risk_level: 'low',
    });

    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('rejected');
    expect(result.message).toContain('outside allowed paths');
  });

  it('rejects plan touching .env', async () => {
    startRun();
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Env ticket',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = ticket.id;

    const result = await processEvent(run, db, 'PLAN_SUBMITTED', {
      ticket_id: ticket.id,
      files_to_touch: [{ path: '.env', action: 'modify', reason: 'add key' }],
      expected_tests: [],
      estimated_lines: 5,
      risk_level: 'low',
    });

    expect(result.message).toContain('rejected');
    expect(result.message).toContain('denied path');
  });

  it('routes high-risk plan to BLOCKED_NEEDS_HUMAN', async () => {
    startRun();
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'High risk ticket',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = ticket.id;

    const result = await processEvent(run, db, 'PLAN_SUBMITTED', {
      ticket_id: ticket.id,
      files_to_touch: [{ path: 'src/foo.ts', action: 'modify', reason: 'risky change' }],
      expected_tests: ['npm test'],
      estimated_lines: 50,
      risk_level: 'high',
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('BLOCKED_NEEDS_HUMAN');
    expect(result.message).toContain('human approval');
  });

  it('auto-approves low-risk plan within scope', async () => {
    startRun();
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Good ticket',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = ticket.id;

    const result = await processEvent(run, db, 'PLAN_SUBMITTED', {
      ticket_id: ticket.id,
      files_to_touch: [{ path: 'src/foo.ts', action: 'modify', reason: 'fix bug' }],
      expected_tests: ['npm test'],
      estimated_lines: 10,
      risk_level: 'low',
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('EXECUTE');
  });

  it('auto-approves medium-risk plan within scope', async () => {
    startRun();
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Medium risk ticket',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = ticket.id;

    const result = await processEvent(run, db, 'PLAN_SUBMITTED', {
      ticket_id: ticket.id,
      files_to_touch: [{ path: 'src/foo.ts', action: 'modify', reason: 'refactor' }],
      expected_tests: ['npm test'],
      estimated_lines: 50,
      risk_level: 'medium',
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('EXECUTE');
  });

  it('rejects plan exceeding max files', async () => {
    startRun();
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Many files ticket',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = ticket.id;

    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `src/file${i}.ts`, action: 'modify', reason: 'change',
    }));

    const result = await processEvent(run, db, 'PLAN_SUBMITTED', {
      ticket_id: ticket.id,
      files_to_touch: files,
      expected_tests: [],
      estimated_lines: 50,
      risk_level: 'low',
    });

    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('rejected');
  });
});

// ---------------------------------------------------------------------------
// Advance: docs category skips plan
// ---------------------------------------------------------------------------

describe('advance — docs category bypasses plan', () => {
  it('skips PLAN phase for docs tickets', async () => {
    startRun({ categories: ['docs', 'refactor'] });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Update README',
      description: 'Add usage docs',
      status: 'ready',
      priority: 60,
      category: 'docs',
      allowedPaths: ['docs/**', '*.md'],
      verificationCommands: [],
    });

    const resp = await advance({ run, db, project });

    // Should skip PLAN and go to EXECUTE
    expect(resp.phase).toBe('EXECUTE');
    expect(resp.constraints.plan_required).toBe(false);
  });

  it('requires PLAN phase for refactor tickets', async () => {
    startRun();

    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Refactor utils',
      description: 'Clean up',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: ['npm test'],
    });

    const resp = await advance({ run, db, project });

    expect(resp.phase).toBe('PLAN');
    expect(resp.constraints.plan_required).toBe(true);
  });
});
