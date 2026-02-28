/**
 * Tests for scope policy derivation, plan validation, and file checking (Phase 4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { repos } from '@promptwheel/core';
import type { DatabaseAdapter, Project } from '@promptwheel/core';
import { RunManager } from '../run-manager.js';
import { processEvent } from '../event-processor.js';
import { advance } from '../advance.js';
import { SessionManager } from '../state.js';
import { registerSessionTools } from '../tools/session.js';
import { registerExecuteTools } from '../tools/execute.js';
import {
  deriveScopePolicy,
  validatePlanScope,
  isFileAllowed,
  isFileInWorktree,
  containsCredentials,
  serializeScopePolicy,
  getCategoryToolPolicy,
  isCategoryFileAllowed,
} from '../scope-policy.js';
import { ingestTicketEvent } from '../ticket-worker.js';
import type { TicketWorkerContext } from '../ticket-worker.js';

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

  it('accepts files inside directory-style allowed_paths (trailing slash)', () => {
    const dirPolicy = deriveScopePolicy({
      allowedPaths: ['src/test/', 'src/lib/foo.ts'],
      category: 'test',
      maxLinesPerTicket: 1000,
    });
    const result = validatePlanScope(
      [
        { path: 'src/test/foo.test.ts', action: 'create', reason: 'new test' },
        { path: 'src/lib/foo.ts', action: 'modify', reason: 'export function' },
      ],
      50, 'low', dirPolicy,
    );
    expect(result.valid).toBe(true);
  });

  it('validates plan with Next.js dynamic route bracket paths', () => {
    const bracketPolicy = deriveScopePolicy({
      allowedPaths: [
        'cloud/app/api/projects/[projectId]/proposals/[proposalId]/approve/route.ts',
        'cloud/app/api/projects/[projectId]/proposals/[proposalId]/reject/route.ts',
      ],
      category: 'security',
      maxLinesPerTicket: 500,
    });
    const result = validatePlanScope(
      [
        { path: 'cloud/app/api/projects/[projectId]/proposals/[proposalId]/approve/route.ts', action: 'modify', reason: 'add role check' },
        { path: 'cloud/app/api/projects/[projectId]/proposals/[proposalId]/reject/route.ts', action: 'modify', reason: 'add role check' },
      ],
      20, 'low', bracketPolicy,
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects files not matching bracket paths', () => {
    const bracketPolicy = deriveScopePolicy({
      allowedPaths: ['cloud/app/api/projects/[projectId]/route.ts'],
      category: 'security',
      maxLinesPerTicket: 500,
    });
    const result = validatePlanScope(
      [{ path: 'cloud/app/api/projects/other/route.ts', action: 'modify', reason: 'test' }],
      10, 'low', bracketPolicy,
    );
    expect(result.valid).toBe(false);
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

  it('allows files with Next.js bracket paths (literal match)', () => {
    const bracketPolicy = deriveScopePolicy({
      allowedPaths: ['cloud/app/api/projects/[projectId]/proposals/[proposalId]/approve/route.ts'],
      category: 'security',
      maxLinesPerTicket: 500,
    });
    expect(isFileAllowed('cloud/app/api/projects/[projectId]/proposals/[proposalId]/approve/route.ts', bracketPolicy)).toBe(true);
  });

  it('denies non-matching paths when allowed_paths contain brackets', () => {
    const bracketPolicy = deriveScopePolicy({
      allowedPaths: ['cloud/app/api/projects/[projectId]/route.ts'],
      category: 'security',
      maxLinesPerTicket: 500,
    });
    expect(isFileAllowed('cloud/app/api/projects/other/route.ts', bracketPolicy)).toBe(false);
  });

  it('allows files inside directory-style allowed_paths (trailing slash)', () => {
    const dirPolicy = deriveScopePolicy({
      allowedPaths: ['src/handlers/', 'src/utils/validate.ts'],
      category: 'refactor',
      maxLinesPerTicket: 500,
    });
    expect(isFileAllowed('src/handlers/signup.ts', dirPolicy)).toBe(true);
    expect(isFileAllowed('src/utils/validate.ts', dirPolicy)).toBe(true);
    expect(isFileAllowed('src/other/foo.ts', dirPolicy)).toBe(false);
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

// ---------------------------------------------------------------------------
// Phase 1: Category Tool Policies
// ---------------------------------------------------------------------------

describe('getCategoryToolPolicy', () => {
  it('returns restricted patterns for docs category', () => {
    const policy = getCategoryToolPolicy('docs');
    expect(policy).not.toBeNull();
    expect(policy!.auto_approve_patterns).toContain('Read(*)');
    expect(policy!.auto_approve_patterns).toContain('Edit(*.md)');
    expect(policy!.auto_approve_patterns).not.toContain('Edit(*)');
    expect(policy!.constraint_note).toContain('docs');
  });

  it('returns restricted patterns for test category', () => {
    const policy = getCategoryToolPolicy('test');
    expect(policy).not.toBeNull();
    expect(policy!.auto_approve_patterns).toContain('Edit(*.test.*)');
    expect(policy!.auto_approve_patterns).toContain('Edit(*.spec.*)');
    expect(policy!.auto_approve_patterns).not.toContain('Edit(*)');
    expect(policy!.constraint_note).toContain('test');
  });

  it('returns restricted patterns for security category', () => {
    const policy = getCategoryToolPolicy('security');
    expect(policy).not.toBeNull();
    expect(policy!.auto_approve_patterns).toContain('Edit(*)');
    expect(policy!.constraint_note).toContain('security');
    expect(policy!.constraint_note).toContain('npm install');
  });

  it('returns null for refactor category (no restrictions)', () => {
    const policy = getCategoryToolPolicy('refactor');
    expect(policy).toBeNull();
  });

  it('returns null for null category', () => {
    const policy = getCategoryToolPolicy(null);
    expect(policy).toBeNull();
  });

  it('returns null for unknown category', () => {
    const policy = getCategoryToolPolicy('unknown-cat');
    expect(policy).toBeNull();
  });
});

describe('advance — category tool policies in auto_approve_patterns', () => {
  it('uses docs auto_approve_patterns for docs ticket', async () => {
    startRun({ categories: ['docs', 'refactor'] });

    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Update README',
      description: 'Add docs',
      status: 'ready',
      priority: 60,
      category: 'docs',
      allowedPaths: ['docs/**', '*.md'],
      verificationCommands: [],
    });

    const resp = await advance({ run, db, project });
    // docs skips plan → goes to EXECUTE
    expect(resp.phase).toBe('EXECUTE');
    expect(resp.constraints.auto_approve_patterns).toContain('Edit(*.md)');
    expect(resp.constraints.auto_approve_patterns).not.toContain('Edit(*)');
  });

  it('uses default EXECUTE_AUTO_APPROVE for refactor ticket', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Refactor foo',
      description: 'Cleanup',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: ['npm test'],
    });

    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = ticket.id;
    s.plan_approved = true;

    const resp = await advance({ run, db, project });
    expect(resp.phase).toBe('EXECUTE');
    expect(resp.constraints.auto_approve_patterns).toContain('Edit(*)');
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Worktree Isolation Enforcement
// ---------------------------------------------------------------------------

describe('isFileInWorktree', () => {
  it('accepts file inside worktree', () => {
    expect(isFileInWorktree('.promptwheel/worktrees/t1/src/foo.ts', '.promptwheel/worktrees/t1')).toBe(true);
  });

  it('accepts exact worktree root', () => {
    expect(isFileInWorktree('.promptwheel/worktrees/t1', '.promptwheel/worktrees/t1')).toBe(true);
  });

  it('rejects file outside worktree', () => {
    expect(isFileInWorktree('src/foo.ts', '.promptwheel/worktrees/t1')).toBe(false);
  });

  it('rejects file in different worktree', () => {
    expect(isFileInWorktree('.promptwheel/worktrees/t2/src/foo.ts', '.promptwheel/worktrees/t1')).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    expect(isFileInWorktree('.promptwheel/worktrees/t1/../t2/foo.ts', '.promptwheel/worktrees/t1')).toBe(false);
  });

  it('handles trailing slash on worktree root', () => {
    expect(isFileInWorktree('.promptwheel/worktrees/t1/foo.ts', '.promptwheel/worktrees/t1/')).toBe(true);
  });

  it('rejects symlink escape outside worktree root', () => {
    const worktreeRoot = path.join(tmpDir, 'worktree');
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(worktreeRoot, 'escape-link'));

    expect(isFileInWorktree(path.join(worktreeRoot, 'escape-link', 'foo.ts'), worktreeRoot)).toBe(false);
  });
});

describe('isFileAllowed with worktree_root', () => {
  it('blocks files outside worktree when worktree_root is set', () => {
    const policy = deriveScopePolicy({
      allowedPaths: ['src/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
      worktreeRoot: '/tmp/project/.promptwheel/worktrees/t1',
    });
    // File is in the main tree, not in the worktree — should be blocked
    expect(isFileAllowed('src/foo.ts', policy)).toBe(false);
  });

  it('allows files inside worktree when worktree_root is set', () => {
    const worktreeRoot = path.join(tmpDir, '.promptwheel', 'worktrees', 't1');
    fs.mkdirSync(path.join(worktreeRoot, 'src'), { recursive: true });
    const policy = deriveScopePolicy({
      allowedPaths: [],
      category: 'refactor',
      maxLinesPerTicket: 500,
      worktreeRoot,
    });
    expect(isFileAllowed(path.join(worktreeRoot, 'src', 'foo.ts'), policy)).toBe(true);
  });

  it('denies metadata paths inside worktree prefixes', () => {
    const worktreeRoot = path.join(tmpDir, '.promptwheel', 'worktrees', 't1');
    fs.mkdirSync(path.join(worktreeRoot, '.git'), { recursive: true });
    const policy = deriveScopePolicy({
      allowedPaths: [],
      category: 'refactor',
      maxLinesPerTicket: 500,
      worktreeRoot,
    });
    expect(isFileAllowed(path.join(worktreeRoot, '.git', 'config'), policy)).toBe(false);
  });

  it('rejects symlink escape even when allowed paths would otherwise match', () => {
    const worktreeRoot = path.join(tmpDir, '.promptwheel', 'worktrees', 't1');
    const outsideDir = path.join(tmpDir, 'outside-src');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(worktreeRoot, 'src'));

    const policy = deriveScopePolicy({
      allowedPaths: ['src/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
      worktreeRoot,
    });
    expect(isFileAllowed(path.join(worktreeRoot, 'src', 'foo.ts'), policy)).toBe(false);
  });

  it('behaves normally when worktree_root is not set (backwards compat)', () => {
    const policy = deriveScopePolicy({
      allowedPaths: ['src/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
    });
    expect(isFileAllowed('src/foo.ts', policy)).toBe(true);
  });
});

describe('serializeScopePolicy with worktree_root', () => {
  it('includes worktree_root when set', () => {
    const policy = deriveScopePolicy({
      allowedPaths: ['src/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
      worktreeRoot: '/tmp/project/.promptwheel/worktrees/t1',
    });
    const serialized = serializeScopePolicy(policy);
    expect(serialized.worktree_root).toBe('/tmp/project/.promptwheel/worktrees/t1');
  });

  it('omits worktree_root when not set', () => {
    const policy = deriveScopePolicy({
      allowedPaths: ['src/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
    });
    const serialized = serializeScopePolicy(policy);
    expect(serialized.worktree_root).toBeUndefined();
  });
});

describe('scope policy parity between tools and runtime checks', () => {
  it('uses worktree_root in get_scope_policy and matches validate_scope allow/deny', async () => {
    const state = new SessionManager(db, project, tmpDir);
    state.start({
      step_budget: 100,
      ticket_step_budget: 12,
      max_prs: 5,
      parallel: 1,
      direct: false,
    });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Worktree parity ticket',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const active = state.run.require();
    active.current_ticket_id = ticket.id;

    const worktreeRoot = path.resolve(tmpDir, '.promptwheel', 'worktrees', ticket.id);
    fs.mkdirSync(path.join(worktreeRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(worktreeRoot, '.git'), { recursive: true });
    const allowedFile = path.join(worktreeRoot, 'src', 'foo.ts');
    const deniedFile = path.join(worktreeRoot, '.git', 'config');

    type ToolHandler = (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const handlers = new Map<string, ToolHandler>();
    const fakeServer = {
      tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
      },
    };

    registerSessionTools(fakeServer as any, () => state);
    registerExecuteTools(fakeServer as any, () => state);

    const getScopePolicy = handlers.get('promptwheel_get_scope_policy');
    const validateScope = handlers.get('promptwheel_validate_scope');
    expect(getScopePolicy).toBeDefined();
    expect(validateScope).toBeDefined();

    const policyResp = await getScopePolicy!({ file_path: allowedFile });
    const policyBody = JSON.parse(policyResp.content[0].text) as Record<string, unknown>;
    const policy = policyBody.policy as Record<string, unknown>;
    const fileCheck = policyBody.file_check as Record<string, unknown>;
    expect(policy.worktree_root).toBe(worktreeRoot);
    expect(fileCheck.allowed).toBe(true);

    const validateAllowedResp = await validateScope!({
      ticketId: ticket.id,
      changedFiles: [allowedFile],
    });
    const validateAllowedBody = JSON.parse(validateAllowedResp.content[0].text) as Record<string, unknown>;
    expect(validateAllowedBody.valid).toBe(true);

    const deniedScopeResp = await getScopePolicy!({ file_path: deniedFile });
    const deniedScopeBody = JSON.parse(deniedScopeResp.content[0].text) as Record<string, unknown>;
    expect((deniedScopeBody.file_check as Record<string, unknown>).allowed).toBe(false);

    const validateDeniedResp = await validateScope!({
      ticketId: ticket.id,
      changedFiles: [deniedFile],
    });
    const validateDeniedBody = JSON.parse(validateDeniedResp.content[0].text) as Record<string, unknown>;
    expect(validateDeniedBody.valid).toBe(false);

    state.end();
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Cross-Verify
// ---------------------------------------------------------------------------

describe('cross_verify — ticket worker state transitions', () => {
  it('TICKET_RESULT transitions to QA when cross_verify is false', async () => {
    startRun({ cross_verify: false });
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Test ticket',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: ['npm test'],
    });

    run.initTicketWorker(ticket.id, ticket);
    run.updateTicketWorker(ticket.id, { phase: 'EXECUTE', plan_approved: true });

    const ctx: TicketWorkerContext = { run, db, project };
    const result = await ingestTicketEvent(ctx, ticket.id, 'TICKET_RESULT', {
      status: 'success',
      changed_files: ['src/foo.ts'],
    });

    expect(result.processed).toBe(true);
    expect(result.message).toContain('QA');
    expect(result.message).not.toContain('CROSS_QA');
    const worker = run.getTicketWorker(ticket.id);
    expect(worker?.phase).toBe('QA');
  });

  it('TICKET_RESULT transitions to CROSS_QA when cross_verify is true', async () => {
    startRun({ cross_verify: true });
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Cross-verify ticket',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: ['npm test'],
    });

    run.initTicketWorker(ticket.id, ticket);
    run.updateTicketWorker(ticket.id, { phase: 'EXECUTE', plan_approved: true });

    const ctx: TicketWorkerContext = { run, db, project };
    const result = await ingestTicketEvent(ctx, ticket.id, 'TICKET_RESULT', {
      status: 'success',
      changed_files: ['src/foo.ts'],
    });

    expect(result.processed).toBe(true);
    expect(result.message).toContain('CROSS_QA');
    const worker = run.getTicketWorker(ticket.id);
    expect(worker?.phase).toBe('CROSS_QA');
  });

  it('QA_PASSED in CROSS_QA phase completes ticket', async () => {
    startRun({ cross_verify: true });
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Cross-verify pass',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: ['npm test'],
    });

    run.initTicketWorker(ticket.id, ticket);
    run.updateTicketWorker(ticket.id, { phase: 'CROSS_QA', plan_approved: true });

    const ctx: TicketWorkerContext = { run, db, project };
    const result = await ingestTicketEvent(ctx, ticket.id, 'QA_PASSED', {});

    expect(result.processed).toBe(true);
    expect(result.message).toContain('complete');
    // Worker should be cleaned up (completed)
    const worker = run.getTicketWorker(ticket.id);
    expect(worker).toBeNull();
  });

  it('QA_FAILED in CROSS_QA phase sends back to EXECUTE', async () => {
    startRun({ cross_verify: true });
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Cross-verify fail',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: ['npm test'],
    });

    run.initTicketWorker(ticket.id, ticket);
    run.updateTicketWorker(ticket.id, { phase: 'CROSS_QA', plan_approved: true });

    const ctx: TicketWorkerContext = { run, db, project };
    const result = await ingestTicketEvent(ctx, ticket.id, 'QA_FAILED', {
      reason: 'Tests failed',
    });

    expect(result.processed).toBe(true);
    expect(result.message).toContain('retrying');
    const worker = run.getTicketWorker(ticket.id);
    expect(worker?.phase).toBe('EXECUTE');
  });

  it('cross_verify defaults to false', () => {
    startRun();
    const s = run.require();
    expect(s.cross_verify).toBe(false);
  });

  it('cross_verify can be enabled via config', () => {
    startRun({ cross_verify: true });
    const s = run.require();
    expect(s.cross_verify).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isCategoryFileAllowed — enforcement of category file-type restrictions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Adaptive Trust — deriveScopePolicy with learnings
// ---------------------------------------------------------------------------

describe('deriveScopePolicy with adaptive trust', () => {
  it('returns unchanged behavior when no learnings parameter', () => {
    const policy = deriveScopePolicy({
      allowedPaths: ['src/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
    });
    expect(policy.max_files).toBe(10);
    expect(policy.max_lines).toBe(500);
    expect(policy.plan_required).toBe(true);
    expect(policy.risk_assessment).toBeUndefined();
  });

  it('returns low risk with relaxed limits for empty learnings', () => {
    const policy = deriveScopePolicy({
      allowedPaths: ['src/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
      learnings: [],
    });
    // Empty learnings array → assessAdaptiveRisk not called (length check)
    expect(policy.max_files).toBe(10);
    expect(policy.risk_assessment).toBeUndefined();
  });

  it('returns low risk with relaxed limits when learnings have no path overlap', () => {
    const { makeLearning } = (() => {
      // Local helper for scope-policy tests
      return {
        makeLearning: (overrides: Record<string, unknown> = {}) => ({
          id: 'test-1',
          text: 'Test learning',
          category: 'gotcha',
          source: { type: 'qa_failure' },
          tags: ['path:lib/other'],
          weight: 50,
          created_at: new Date().toISOString(),
          last_confirmed_at: new Date().toISOString(),
          access_count: 0,
          ...overrides,
        }),
      };
    })();

    const policy = deriveScopePolicy({
      allowedPaths: ['src/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
      learnings: [makeLearning()] as any,
    });
    // No path overlap → score 0 → low → max_files 15, maxLines * 1.5
    expect(policy.risk_assessment?.level).toBe('low');
    expect(policy.max_files).toBe(15);
    expect(policy.max_lines).toBe(750);
  });

  it('tightens limits for elevated risk (multiple failures)', () => {
    const learnings = Array.from({ length: 4 }, (_, i) => ({
      id: `fail-${i}`,
      text: `Failure ${i}`,
      category: 'gotcha' as const,
      source: { type: 'qa_failure' as const },
      tags: ['path:src/config'],
      weight: 50,
      created_at: new Date().toISOString(),
      last_confirmed_at: new Date().toISOString(),
      access_count: 0,
    }));

    const policy = deriveScopePolicy({
      allowedPaths: ['src/config/**'],
      category: 'refactor',
      maxLinesPerTicket: 500,
      learnings: learnings as any,
    });
    // 4 failures × 10*(50/50) = 40 → elevated
    expect(policy.risk_assessment?.level).toBe('elevated');
    expect(policy.max_files).toBe(7);
    expect(policy.plan_required).toBe(true);
  });

  it('overrides docs category plan_required=false when risk is high', () => {
    const learnings = Array.from({ length: 3 }, (_, i) => ({
      id: `fragile-${i}`,
      text: `Fragile issue ${i}`,
      category: 'gotcha' as const,
      source: { type: 'qa_failure' as const },
      tags: ['path:docs'],
      weight: 80,
      created_at: new Date().toISOString(),
      last_confirmed_at: new Date().toISOString(),
      access_count: 0,
      structured: {
        fragile_paths: ['docs/api.md'],
        pattern_type: 'antipattern' as const,
      },
    }));

    const policy = deriveScopePolicy({
      allowedPaths: ['docs/**'],
      category: 'docs',
      maxLinesPerTicket: 500,
      learnings: learnings as any,
    });
    // High risk overrides the docs plan_required=false default
    expect(policy.risk_assessment?.level).toBe('high');
    expect(policy.plan_required).toBe(true);
    expect(policy.max_files).toBe(5);
  });
});

describe('isCategoryFileAllowed', () => {
  it('allows any file when category is null', () => {
    expect(isCategoryFileAllowed('src/foo.ts', null)).toBe(true);
  });

  it('allows any file for categories without restrictions (fix, refactor, security)', () => {
    expect(isCategoryFileAllowed('src/foo.ts', 'fix')).toBe(true);
    expect(isCategoryFileAllowed('src/foo.ts', 'refactor')).toBe(true);
    expect(isCategoryFileAllowed('src/foo.ts', 'security')).toBe(true);
  });

  it('docs category allows markdown files', () => {
    expect(isCategoryFileAllowed('README.md', 'docs')).toBe(true);
    expect(isCategoryFileAllowed('docs/guide.mdx', 'docs')).toBe(true);
    expect(isCategoryFileAllowed('CHANGELOG.txt', 'docs')).toBe(true);
    expect(isCategoryFileAllowed('docs/api.rst', 'docs')).toBe(true);
  });

  it('docs category rejects source code files', () => {
    expect(isCategoryFileAllowed('src/foo.ts', 'docs')).toBe(false);
    expect(isCategoryFileAllowed('lib/bar.js', 'docs')).toBe(false);
    expect(isCategoryFileAllowed('package.json', 'docs')).toBe(false);
    expect(isCategoryFileAllowed('tsconfig.json', 'docs')).toBe(false);
  });

  it('test category allows test files', () => {
    expect(isCategoryFileAllowed('src/foo.test.ts', 'test')).toBe(true);
    expect(isCategoryFileAllowed('lib/bar.spec.js', 'test')).toBe(true);
    expect(isCategoryFileAllowed('__tests__/baz.ts', 'test')).toBe(true);
    expect(isCategoryFileAllowed('src/__tests__/foo.ts', 'test')).toBe(true);
  });

  it('test category rejects production source files', () => {
    expect(isCategoryFileAllowed('src/foo.ts', 'test')).toBe(false);
    expect(isCategoryFileAllowed('lib/bar.js', 'test')).toBe(false);
    expect(isCategoryFileAllowed('index.ts', 'test')).toBe(false);
  });
});
