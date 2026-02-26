import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import * as projects from '../repos/projects.js';
import * as tickets from '../repos/tickets.js';
import * as runs from '../repos/runs.js';
import * as runSteps from '../repos/run_steps.js';
import type { DatabaseAdapter } from '../db/adapter.js';

let db: DatabaseAdapter;

beforeEach(async () => {
  db = await createSQLiteAdapter({ url: ':memory:' });
});

afterEach(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
describe('projects repo — extended', () => {
  it('getById returns null for non-existent id', async () => {
    const result = await projects.getById(db, 'proj_nonexistent');
    expect(result).toBeNull();
  });

  it('getByRepoRoot returns null when no match', async () => {
    const result = await projects.getByRepoRoot(db, '/no/such/path');
    expect(result).toBeNull();
  });

  it('ensureForRepo creates with generated id when id omitted', async () => {
    const p = await projects.ensureForRepo(db, {
      name: 'auto-id-proj',
      rootPath: '/tmp/auto-id-proj',
    });
    expect(p.id).toMatch(/^proj_/);
    expect(p.repoUrl).toBeNull();
  });

  it('ensureForRepo is idempotent on rootPath', async () => {
    const p1 = await projects.ensureForRepo(db, {
      name: 'idem',
      rootPath: '/tmp/idempotent',
      repoUrl: 'https://github.com/a/b',
    });
    const p2 = await projects.ensureForRepo(db, {
      name: 'idem-different',
      rootPath: '/tmp/idempotent',
    });
    expect(p1.id).toBe(p2.id);
    expect(p2.name).toBe('idem'); // original name kept
  });

  it('remove deletes project and cascaded data', async () => {
    const p = await projects.ensureForRepo(db, {
      id: 'proj_del',
      name: 'to-delete',
      rootPath: '/tmp/to-delete',
    });
    // create a ticket + run linked to ticket so cascade works
    const tkt = await tickets.create(db, { projectId: p.id, title: 'will-die' });
    await runs.create(db, { projectId: p.id, ticketId: tkt.id, type: 'scout' });

    await projects.remove(db, p.id);

    expect(await projects.getById(db, p.id)).toBeNull();
    expect(await tickets.getById(db, tkt.id)).toBeNull();
  });

  it('list orders by updated_at DESC', async () => {
    const oldest = await projects.ensureForRepo(db, {
      id: 'proj_list_oldest',
      name: 'oldest',
      rootPath: '/tmp/proj-list-oldest',
    });
    const newest = await projects.ensureForRepo(db, {
      id: 'proj_list_newest',
      name: 'newest',
      rootPath: '/tmp/proj-list-newest',
    });
    const middle = await projects.ensureForRepo(db, {
      id: 'proj_list_middle',
      name: 'middle',
      rootPath: '/tmp/proj-list-middle',
    });

    await db.query('UPDATE projects SET updated_at = $1 WHERE id = $2', ['2024-01-01T00:00:00.000Z', oldest.id]);
    await db.query('UPDATE projects SET updated_at = $1 WHERE id = $2', ['2024-01-03T00:00:00.000Z', newest.id]);
    await db.query('UPDATE projects SET updated_at = $1 WHERE id = $2', ['2024-01-02T00:00:00.000Z', middle.id]);

    const all = await projects.list(db);
    expect(all.map(project => project.id)).toEqual([newest.id, middle.id, oldest.id]);
  });
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
describe('tickets repo — extended', () => {
  let projId: string;

  beforeEach(async () => {
    const p = await projects.ensureForRepo(db, {
      id: 'proj_tkt_ext',
      name: 'tickets-ext',
      rootPath: '/tmp/tickets-ext',
    });
    projId = p.id;
  });

  it('creates ticket with all optional fields', async () => {
    const tkt = await tickets.create(db, {
      projectId: projId,
      title: 'Full ticket',
      description: 'Detailed description',
      status: 'backlog',
      priority: 99,
      shard: 'packages/core',
      category: 'security',
      allowedPaths: ['src/a.ts', 'src/b.ts'],
      forbiddenPaths: ['node_modules'],
      verificationCommands: ['npm run build', 'npm test'],
      maxRetries: 5,
    });

    expect(tkt.status).toBe('backlog');
    expect(tkt.priority).toBe(99);
    expect(tkt.shard).toBe('packages/core');
    expect(tkt.category).toBe('security');
    expect(tkt.allowedPaths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(tkt.forbiddenPaths).toEqual(['node_modules']);
    expect(tkt.verificationCommands).toEqual(['npm run build', 'npm test']);
    expect(tkt.maxRetries).toBe(5);
    expect(tkt.retryCount).toBe(0);
  });

  it('creates ticket with defaults when optionals omitted', async () => {
    const tkt = await tickets.create(db, {
      projectId: projId,
      title: 'Minimal ticket',
    });
    expect(tkt.status).toBe('ready');
    expect(tkt.priority).toBe(0);
    expect(tkt.shard).toBeNull();
    expect(tkt.category).toBeNull();
    expect(tkt.allowedPaths).toEqual([]);
    expect(tkt.forbiddenPaths).toEqual([]);
    expect(tkt.verificationCommands).toEqual([]);
    expect(tkt.maxRetries).toBe(3);
    expect(tkt.description).toBeNull();
  });

  it('getById returns null for missing ticket', async () => {
    expect(await tickets.getById(db, 'tkt_nonexistent')).toBeNull();
  });

  it('createMany creates multiple tickets transactionally', async () => {
    const created = await tickets.createMany(db, [
      { projectId: projId, title: 'Batch A', priority: 10 },
      { projectId: projId, title: 'Batch B', priority: 20 },
      { projectId: projId, title: 'Batch C', priority: 30 },
    ]);
    expect(created).toHaveLength(3);
    expect(created.map(t => t.title)).toEqual(['Batch A', 'Batch B', 'Batch C']);
  });

  it('listByProject with array of statuses', async () => {
    const blocked = await tickets.create(db, {
      projectId: projId,
      title: 'Blocked',
      status: 'blocked',
    });
    const aborted = await tickets.create(db, {
      projectId: projId,
      title: 'Aborted',
      status: 'aborted',
    });
    await tickets.create(db, { projectId: projId, title: 'Ready', status: 'ready' });

    await db.query('UPDATE tickets SET created_at = $1 WHERE id = $2', ['2024-01-01T00:00:00.000Z', blocked.id]);
    await db.query('UPDATE tickets SET created_at = $1 WHERE id = $2', ['2024-01-02T00:00:00.000Z', aborted.id]);

    const result = await tickets.listByProject(db, projId, {
      status: ['blocked', 'aborted'],
    });
    expect(result.map(ticket => ticket.id)).toEqual([aborted.id, blocked.id]);
  });

  it('listByProject respects limit', async () => {
    await tickets.create(db, { projectId: projId, title: 'Low', priority: 10 });
    await tickets.create(db, { projectId: projId, title: 'Mid', priority: 20 });
    await tickets.create(db, { projectId: projId, title: 'High', priority: 30 });

    const result = await tickets.listByProject(db, projId, { limit: 2 });
    expect(result.map(ticket => ticket.title)).toEqual(['High', 'Mid']);
  });

  it('listByProject orders by priority DESC then created_at DESC', async () => {
    const low = await tickets.create(db, { projectId: projId, title: 'Low', priority: 1 });
    const prioritySameOlder = await tickets.create(db, {
      projectId: projId,
      title: 'Priority Same Older',
      priority: 5,
    });
    const prioritySameNewer = await tickets.create(db, {
      projectId: projId,
      title: 'Priority Same Newer',
      priority: 5,
    });

    await db.query('UPDATE tickets SET created_at = $1 WHERE id = $2', [
      '2024-01-01T00:00:00.000Z',
      prioritySameOlder.id,
    ]);
    await db.query('UPDATE tickets SET created_at = $1 WHERE id = $2', [
      '2024-01-02T00:00:00.000Z',
      prioritySameNewer.id,
    ]);
    await db.query('UPDATE tickets SET created_at = $1 WHERE id = $2', ['2024-01-03T00:00:00.000Z', low.id]);

    const all = await tickets.listByProject(db, projId);
    expect(all.map(ticket => ticket.id)).toEqual([
      prioritySameNewer.id,
      prioritySameOlder.id,
      low.id,
    ]);
  });

  it('updateStatus transitions through multiple states', async () => {
    const tkt = await tickets.create(db, { projectId: projId, title: 'Transition' });
    expect(tkt.status).toBe('ready');

    await tickets.updateStatus(db, tkt.id, 'leased');
    await tickets.updateStatus(db, tkt.id, 'in_progress');
    await tickets.updateStatus(db, tkt.id, 'in_review');
    const final = await tickets.updateStatus(db, tkt.id, 'done');
    expect(final!.status).toBe('done');

    const raw = await db.query<{ updated_at: string }>(
      'SELECT updated_at FROM tickets WHERE id = $1',
      [tkt.id]
    );
    expect(raw.rows[0]!.updated_at).toContain('T');
    expect(raw.rows[0]!.updated_at.endsWith('Z')).toBe(true);
  });

  it('updateStatus returns null for non-existent ticket', async () => {
    // updateStatus does UPDATE then getById; getById returns null
    const result = await tickets.updateStatus(db, 'tkt_gone', 'done');
    // The row won't exist so getById returns null
    expect(result).toBeNull();
  });

  it('getRecentlyCompleted returns done tickets', async () => {
    const doneLow = await tickets.create(db, {
      projectId: projId,
      title: 'Done Low',
      status: 'done',
      priority: 1,
    });
    const doneHigh = await tickets.create(db, {
      projectId: projId,
      title: 'Done High',
      status: 'done',
      priority: 10,
    });
    await tickets.create(db, { projectId: projId, title: 'Ready', status: 'ready', priority: 999 });

    await db.query('UPDATE tickets SET created_at = $1 WHERE id = $2', ['2024-01-01T00:00:00.000Z', doneLow.id]);
    await db.query('UPDATE tickets SET created_at = $1 WHERE id = $2', ['2024-01-02T00:00:00.000Z', doneHigh.id]);

    const recent = await tickets.getRecentlyCompleted(db, projId, 5);
    expect(recent.map(ticket => ticket.id)).toEqual([doneHigh.id, doneLow.id]);
  });

  it('countByStatus returns correct counts', async () => {
    await tickets.create(db, { projectId: projId, title: 'Ready 1', status: 'ready' });
    await tickets.create(db, { projectId: projId, title: 'Done 1', status: 'done' });
    await tickets.create(db, { projectId: projId, title: 'Done 2', status: 'done' });
    await tickets.create(db, { projectId: projId, title: 'Blocked 1', status: 'blocked' });

    const counts = await tickets.countByStatus(db, projId);
    expect(counts).toEqual({
      backlog: 0,
      ready: 1,
      leased: 0,
      in_progress: 0,
      in_review: 0,
      done: 2,
      blocked: 1,
      aborted: 0,
    });
  });

  it('findSimilarByTitle is case-insensitive', async () => {
    await tickets.create(db, { projectId: projId, title: 'Unique Title XYZ' });
    const found = await tickets.findSimilarByTitle(db, projId, 'unique title xyz');
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Unique Title XYZ');
  });

  it('findSimilarByTitle returns null when no match', async () => {
    const found = await tickets.findSimilarByTitle(db, projId, 'no match here 123456');
    expect(found).toBeNull();
  });

  it('listByProject returns empty for unknown project', async () => {
    const result = await tickets.listByProject(db, 'proj_nonexistent');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
describe('runs repo — extended', () => {
  let projId: string;

  beforeEach(async () => {
    const p = await projects.ensureForRepo(db, {
      id: 'proj_runs_ext',
      name: 'runs-ext',
      rootPath: '/tmp/runs-ext',
    });
    projId = p.id;
  });

  it('creates run with ticketId', async () => {
    const tkt = await tickets.create(db, { projectId: projId, title: 'For run' });
    const run = await runs.create(db, {
      projectId: projId,
      type: 'worker',
      ticketId: tkt.id,
      maxIterations: 5,
      metadata: { branch: 'feat/x' },
    });
    expect(run.ticketId).toBe(tkt.id);
    expect(run.maxIterations).toBe(5);
    expect(run.metadata).toEqual({ branch: 'feat/x' });
    expect(run.startedAt).not.toBeNull();

    const raw = await db.query<{ started_at: string | null }>(
      'SELECT started_at FROM runs WHERE id = $1',
      [run.id]
    );
    expect(raw.rows[0]!.started_at).not.toBeNull();
    expect(raw.rows[0]!.started_at!).toContain('T');
    expect(raw.rows[0]!.started_at!.endsWith('Z')).toBe(true);
  });

  it('getById returns null for non-existent run', async () => {
    expect(await runs.getById(db, 'run_nonexistent')).toBeNull();
  });

  it('markSuccess merges metadata', async () => {
    const run = await runs.create(db, {
      projectId: projId,
      type: 'qa',
      metadata: { a: 1 },
    });
    const updated = await runs.markSuccess(db, run.id, { b: 2 });
    expect(updated!.metadata).toEqual({ a: 1, b: 2 });
    expect(updated!.status).toBe('success');
    expect(updated!.completedAt).not.toBeNull();

    const raw = await db.query<{ completed_at: string | null }>(
      'SELECT completed_at FROM runs WHERE id = $1',
      [run.id]
    );
    expect(raw.rows[0]!.completed_at).not.toBeNull();
    expect(raw.rows[0]!.completed_at!).toContain('T');
    expect(raw.rows[0]!.completed_at!.endsWith('Z')).toBe(true);
  });

  it('markFailure with string error', async () => {
    const run = await runs.create(db, { projectId: projId, type: 'scout' });
    const updated = await runs.markFailure(db, run.id, 'string error');
    expect(updated!.error).toBe('string error');
    expect(updated!.status).toBe('failure');
  });

  it('markSuccess returns null for non-existent run', async () => {
    expect(await runs.markSuccess(db, 'run_nope')).toBeNull();
  });

  it('markFailure returns null for non-existent run', async () => {
    expect(await runs.markFailure(db, 'run_nope', 'err')).toBeNull();
  });

  it('listByProject filters by status array', async () => {
    const success = await runs.create(db, { projectId: projId, type: 'qa' });
    await runs.markSuccess(db, success.id);
    const failure = await runs.create(db, { projectId: projId, type: 'scout' });
    await runs.markFailure(db, failure.id, 'failed');
    await runs.create(db, { projectId: projId, type: 'worker' });

    await db.query('UPDATE runs SET created_at = $1 WHERE id = $2', ['2024-01-01T00:00:00.000Z', success.id]);
    await db.query('UPDATE runs SET created_at = $1 WHERE id = $2', ['2024-01-02T00:00:00.000Z', failure.id]);

    const result = await runs.listByProject(db, projId, {
      status: ['success', 'failure'],
    });
    expect(result.map(run => run.id)).toEqual([failure.id, success.id]);
  });

  it('listByProject filters by type and status combined', async () => {
    const qaSuccess = await runs.create(db, { projectId: projId, type: 'qa' });
    await runs.markSuccess(db, qaSuccess.id);
    const qaFailure = await runs.create(db, { projectId: projId, type: 'qa' });
    await runs.markFailure(db, qaFailure.id, 'qa failed');
    const workerSuccess = await runs.create(db, { projectId: projId, type: 'worker' });
    await runs.markSuccess(db, workerSuccess.id);

    const result = await runs.listByProject(db, projId, {
      type: 'qa',
      status: 'success',
    });
    expect(result.map(run => run.id)).toEqual([qaSuccess.id]);
  });

  it('listByProject respects limit', async () => {
    const oldest = await runs.create(db, { projectId: projId, type: 'worker' });
    const middle = await runs.create(db, { projectId: projId, type: 'worker' });
    const newest = await runs.create(db, { projectId: projId, type: 'worker' });

    await db.query('UPDATE runs SET created_at = $1 WHERE id = $2', ['2024-01-01T00:00:00.000Z', oldest.id]);
    await db.query('UPDATE runs SET created_at = $1 WHERE id = $2', ['2024-01-02T00:00:00.000Z', middle.id]);
    await db.query('UPDATE runs SET created_at = $1 WHERE id = $2', ['2024-01-03T00:00:00.000Z', newest.id]);

    const result = await runs.listByProject(db, projId, { limit: 1 });
    expect(result.map(run => run.id)).toEqual([newest.id]);
  });

  it('countActive counts pending and running', async () => {
    await runs.create(db, { projectId: projId, type: 'worker' });
    await runs.create(db, { projectId: projId, type: 'qa' });
    const completed = await runs.create(db, { projectId: projId, type: 'scout' });
    await runs.markSuccess(db, completed.id);

    const count = await runs.countActive(db, projId);
    expect(count).toBe(2);
  });

  it('countActive without projectId counts globally', async () => {
    await runs.create(db, { projectId: projId, type: 'worker' });
    const localCompleted = await runs.create(db, { projectId: projId, type: 'qa' });
    await runs.markFailure(db, localCompleted.id, 'failed');

    const otherProject = await projects.ensureForRepo(db, {
      id: 'proj_runs_other',
      name: 'runs-other',
      rootPath: '/tmp/runs-other',
    });
    await runs.create(db, { projectId: otherProject.id, type: 'scout' });
    await runs.create(db, { projectId: otherProject.id, type: 'worker' });

    const count = await runs.countActive(db);
    expect(count).toBe(3);
  });

  it('getLatestByType returns most recent', async () => {
    const r1 = await runs.create(db, { projectId: projId, type: 'merge' });
    const r2 = await runs.create(db, { projectId: projId, type: 'merge' });
    await runs.create(db, { projectId: projId, type: 'qa' });

    await db.query('UPDATE runs SET created_at = $1 WHERE id = $2', ['2024-01-01T00:00:00.000Z', r1.id]);
    await db.query('UPDATE runs SET created_at = $1 WHERE id = $2', ['2024-01-02T00:00:00.000Z', r2.id]);

    const latest = await runs.getLatestByType(db, projId, 'merge');
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(r2.id);
  });

  it('getLatestByType returns null when none exist', async () => {
    const p = await projects.ensureForRepo(db, {
      name: 'empty-runs',
      rootPath: '/tmp/empty-runs-test',
    });
    const latest = await runs.getLatestByType(db, p.id, 'worker');
    expect(latest).toBeNull();
  });

  it('getSummary returns structured data', async () => {
    const summary = await runs.getSummary(db, projId);
    expect(summary).toHaveProperty('lastScout');
    expect(summary).toHaveProperty('lastQa');
    expect(summary).toHaveProperty('lastExecute');
    expect(typeof summary.activeRuns).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Run Steps
// ---------------------------------------------------------------------------
describe('run_steps repo — extended', () => {
  let projId: string;
  let runId: string;

  beforeEach(async () => {
    const p = await projects.ensureForRepo(db, {
      id: 'proj_steps_ext',
      name: 'steps-ext',
      rootPath: '/tmp/steps-ext',
    });
    projId = p.id;
    const run = await runs.create(db, { projectId: projId, type: 'qa' });
    runId = run.id;
  });

  it('creates a step with all fields', async () => {
    const step = await runSteps.create(db, {
      runId,
      ordinal: 0,
      name: 'build',
      kind: 'command',
      cmd: 'npm run build',
      cwd: '/tmp',
      timeoutMs: 30000,
      metadata: { env: 'test' },
    });
    expect(step.runId).toBe(runId);
    expect(step.ordinal).toBe(0);
    expect(step.kind).toBe('command');
    expect(step.status).toBe('queued');
    expect(step.cmd).toBe('npm run build');
    expect(step.cwd).toBe('/tmp');
    expect(step.timeoutMs).toBe(30000);
    expect(step.metadata).toEqual({ env: 'test' });
    expect(step.stdoutBytes).toBe(0);
    expect(step.stderrBytes).toBe(0);
    expect(step.stdoutTruncated).toBe(false);
    expect(step.stderrTruncated).toBe(false);
  });

  it('creates step with defaults', async () => {
    const step = await runSteps.create(db, {
      runId,
      ordinal: 1,
      name: 'test',
    });
    expect(step.attempt).toBe(1);
    expect(step.kind).toBe('command');
    expect(step.cmd).toBeNull();
    expect(step.cwd).toBeNull();
    expect(step.timeoutMs).toBeNull();
  });

  it('getById returns null for missing step', async () => {
    expect(await runSteps.getById(db, 'stp_nonexistent')).toBeNull();
  });

  it('createMany creates ordered steps', async () => {
    const newRun = await runs.create(db, { projectId: projId, type: 'qa' });
    const steps = await runSteps.createMany(db, newRun.id, [
      { name: 'lint', cmd: 'npm run lint' },
      { name: 'build', cmd: 'npm run build' },
      { name: 'test', cmd: 'npm test', timeoutMs: 60000 },
    ]);
    expect(steps).toHaveLength(3);
    expect(steps[0].ordinal).toBe(0);
    expect(steps[1].ordinal).toBe(1);
    expect(steps[2].ordinal).toBe(2);
    expect(steps[2].timeoutMs).toBe(60000);
  });

  it('createMany with custom attempt', async () => {
    const newRun = await runs.create(db, { projectId: projId, type: 'qa' });
    const steps = await runSteps.createMany(
      db,
      newRun.id,
      [{ name: 'retry-build', cmd: 'npm run build' }],
      3
    );
    expect(steps[0].attempt).toBe(3);
  });

  it('markStarted sets running and started_at_ms', async () => {
    const step = await runSteps.create(db, { runId, ordinal: 10, name: 'start-test' });
    const started = await runSteps.markStarted(db, step.id);
    expect(started!.status).toBe('running');
    expect(started!.startedAtMs).not.toBeNull();
  });

  it('markSuccess records output details', async () => {
    const step = await runSteps.create(db, { runId, ordinal: 11, name: 'success-test' });
    await runSteps.markStarted(db, step.id);
    const done = await runSteps.markSuccess(db, step.id, {
      exitCode: 0,
      stdoutPath: '/logs/stdout.log',
      stderrPath: '/logs/stderr.log',
      stdoutBytes: 1024,
      stderrBytes: 256,
      stdoutTruncated: true,
      stderrTruncated: false,
      stdoutTail: 'last lines...',
      stderrTail: 'err tail',
      metadata: { extra: true },
    });
    expect(done!.status).toBe('success');
    expect(done!.exitCode).toBe(0);
    expect(done!.stdoutPath).toBe('/logs/stdout.log');
    expect(done!.stdoutBytes).toBe(1024);
    expect(done!.stdoutTruncated).toBe(true);
    expect(done!.stderrTruncated).toBe(false);
    expect(done!.stdoutTail).toBe('last lines...');
    expect(done!.durationMs).not.toBeNull();
    expect(done!.metadata).toEqual(expect.objectContaining({ extra: true }));
  });

  it('markSuccess returns null for missing step', async () => {
    expect(await runSteps.markSuccess(db, 'stp_gone')).toBeNull();
  });

  it('markFailed records error info', async () => {
    const step = await runSteps.create(db, { runId, ordinal: 12, name: 'fail-test' });
    await runSteps.markStarted(db, step.id);
    const failed = await runSteps.markFailed(db, step.id, {
      exitCode: 1,
      signal: 'SIGTERM',
      errorMessage: 'Segfault',
      stdoutTail: 'output before crash',
      stderrTail: 'segfault at 0x0',
    });
    expect(failed!.status).toBe('failed');
    expect(failed!.exitCode).toBe(1);
    expect(failed!.signal).toBe('SIGTERM');
    expect(failed!.errorMessage).toBe('Segfault');
  });

  it('markFailed returns null for missing step', async () => {
    expect(await runSteps.markFailed(db, 'stp_gone', { errorMessage: 'x' })).toBeNull();
  });

  it('markSkipped sets status and reason', async () => {
    const step = await runSteps.create(db, { runId, ordinal: 13, name: 'skip-test' });
    const skipped = await runSteps.markSkipped(db, step.id, 'Previous step failed');
    expect(skipped!.status).toBe('skipped');
    expect(skipped!.errorMessage).toBe('Previous step failed');
  });

  it('markCanceled sets status and reason', async () => {
    const step = await runSteps.create(db, { runId, ordinal: 14, name: 'cancel-test' });
    const canceled = await runSteps.markCanceled(db, step.id, 'User canceled');
    expect(canceled!.status).toBe('canceled');
    expect(canceled!.errorMessage).toBe('User canceled');
  });

  it('listByRun returns steps ordered by attempt,ordinal', async () => {
    const attempt2Ordinal1 = await runSteps.create(db, {
      runId,
      attempt: 2,
      ordinal: 1,
      name: 'a2-o1',
    });
    const attempt1Ordinal0 = await runSteps.create(db, {
      runId,
      attempt: 1,
      ordinal: 0,
      name: 'a1-o0',
    });
    const attempt2Ordinal0 = await runSteps.create(db, {
      runId,
      attempt: 2,
      ordinal: 0,
      name: 'a2-o0',
    });
    const attempt1Ordinal1 = await runSteps.create(db, {
      runId,
      attempt: 1,
      ordinal: 1,
      name: 'a1-o1',
    });

    const steps = await runSteps.listByRun(db, runId);
    expect(steps.map(step => step.id)).toEqual([
      attempt1Ordinal0.id,
      attempt1Ordinal1.id,
      attempt2Ordinal0.id,
      attempt2Ordinal1.id,
    ]);
  });

  it('listByRun filters by attempt', async () => {
    const newRun = await runs.create(db, { projectId: projId, type: 'qa' });
    await runSteps.createMany(db, newRun.id, [{ name: 'a1', cmd: 'echo 1' }], 1);
    await runSteps.createMany(db, newRun.id, [{ name: 'a2', cmd: 'echo 2' }], 2);

    const attempt1 = await runSteps.listByRun(db, newRun.id, { attempt: 1 });
    expect(attempt1).toHaveLength(1);
    expect(attempt1[0].name).toBe('a1');
  });

  it('listByRun filters by status', async () => {
    const success = await runSteps.create(db, { runId, ordinal: 0, name: 'success-step' });
    const failed = await runSteps.create(db, { runId, ordinal: 1, name: 'failed-step' });
    await runSteps.markStarted(db, success.id);
    await runSteps.markSuccess(db, success.id);
    await runSteps.markStarted(db, failed.id);
    await runSteps.markFailed(db, failed.id, { errorMessage: 'failed' });

    const steps = await runSteps.listByRun(db, runId, { status: 'success' });
    expect(steps.map(step => step.id)).toEqual([success.id]);
  });

  it('listByRun filters by status array', async () => {
    const failed = await runSteps.create(db, { runId, ordinal: 0, name: 'failed' });
    const canceled = await runSteps.create(db, { runId, ordinal: 1, name: 'canceled' });
    await runSteps.create(db, { runId, ordinal: 2, name: 'queued' });
    await runSteps.markStarted(db, failed.id);
    await runSteps.markFailed(db, failed.id, { errorMessage: 'boom' });
    await runSteps.markCanceled(db, canceled.id, 'stopped');

    const steps = await runSteps.listByRun(db, runId, { status: ['failed', 'canceled'] });
    expect(steps.map(step => step.id)).toEqual([failed.id, canceled.id]);
  });

  it('getLatestAttempt returns 0 for run with no steps', async () => {
    const newRun = await runs.create(db, { projectId: projId, type: 'qa' });
    const attempt = await runSteps.getLatestAttempt(db, newRun.id);
    expect(attempt).toBe(0);
  });

  it('getLatestAttempt returns max attempt', async () => {
    await runSteps.create(db, { runId, attempt: 1, ordinal: 0, name: 'attempt-1' });
    await runSteps.create(db, { runId, attempt: 3, ordinal: 0, name: 'attempt-3' });

    const attempt = await runSteps.getLatestAttempt(db, runId);
    expect(attempt).toBe(3);
  });

  it('getStepCounts returns correct aggregates', async () => {
    const newRun = await runs.create(db, { projectId: projId, type: 'qa' });
    const steps = await runSteps.createMany(db, newRun.id, [
      { name: 's1', cmd: 'echo 1' },
      { name: 's2', cmd: 'echo 2' },
      { name: 's3', cmd: 'echo 3' },
    ]);
    await runSteps.markStarted(db, steps[0].id);
    await runSteps.markSuccess(db, steps[0].id);
    await runSteps.markStarted(db, steps[1].id);
    await runSteps.markFailed(db, steps[1].id, { errorMessage: 'err' });
    await runSteps.markSkipped(db, steps[2].id, 'skipped');

    const counts = await runSteps.getStepCounts(db, newRun.id, 1);
    expect(counts.passed).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(counts.active).toBe(0);
    expect(counts.total).toBe(3);
  });

  it('getFirstFailedStep returns first by ordinal', async () => {
    const newRun = await runs.create(db, { projectId: projId, type: 'qa' });
    const steps = await runSteps.createMany(db, newRun.id, [
      { name: 'first', cmd: 'a' },
      { name: 'second', cmd: 'b' },
    ]);
    await runSteps.markStarted(db, steps[0].id);
    await runSteps.markFailed(db, steps[0].id, { errorMessage: 'e1' });
    await runSteps.markStarted(db, steps[1].id);
    await runSteps.markFailed(db, steps[1].id, { errorMessage: 'e2' });

    const first = await runSteps.getFirstFailedStep(db, newRun.id);
    expect(first).not.toBeNull();
    expect(first!.name).toBe('first');
  });

  it('getFirstFailedStep returns null when no failures', async () => {
    const newRun = await runs.create(db, { projectId: projId, type: 'qa' });
    const steps = await runSteps.createMany(db, newRun.id, [{ name: 'ok', cmd: 'x' }]);
    await runSteps.markStarted(db, steps[0].id);
    await runSteps.markSuccess(db, steps[0].id);
    expect(await runSteps.getFirstFailedStep(db, newRun.id)).toBeNull();
  });

  it('getRunningStep returns currently running step', async () => {
    const newRun = await runs.create(db, { projectId: projId, type: 'qa' });
    const steps = await runSteps.createMany(db, newRun.id, [
      { name: 'done', cmd: 'x' },
      { name: 'active', cmd: 'y' },
    ]);
    await runSteps.markStarted(db, steps[0].id);
    await runSteps.markSuccess(db, steps[0].id);
    await runSteps.markStarted(db, steps[1].id);

    const running = await runSteps.getRunningStep(db, newRun.id);
    expect(running).not.toBeNull();
    expect(running!.name).toBe('active');
  });

  it('getSummary for run with no steps returns zeros', async () => {
    const newRun = await runs.create(db, { projectId: projId, type: 'qa' });
    const summary = await runSteps.getSummary(db, newRun.id);
    expect(summary.latestAttempt).toBe(0);
    expect(summary.counts.total).toBe(0);
    expect(summary.firstFailedStep).toBeNull();
    expect(summary.runningStep).toBeNull();
    expect(summary.totalDurationMs).toBe(0);
  });

  it('getSummary returns populated data', async () => {
    const newRun = await runs.create(db, { projectId: projId, type: 'qa' });
    const steps = await runSteps.createMany(db, newRun.id, [
      { name: 'lint', cmd: 'npm run lint' },
      { name: 'build', cmd: 'npm run build' },
    ]);
    await runSteps.markStarted(db, steps[0].id);
    await runSteps.markSuccess(db, steps[0].id);
    await runSteps.markStarted(db, steps[1].id);
    await runSteps.markFailed(db, steps[1].id, { errorMessage: 'build failed' });

    const summary = await runSteps.getSummary(db, newRun.id);
    expect(summary.latestAttempt).toBe(1);
    expect(summary.counts.passed).toBe(1);
    expect(summary.counts.failed).toBe(1);
    expect(summary.firstFailedStep).toBe('build');
    expect(summary.runningStep).toBeNull();
  });
});
