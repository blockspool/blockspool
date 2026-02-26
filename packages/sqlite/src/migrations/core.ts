import type { Migration } from '@promptwheel/core/db';

interface SQLiteCoreMigrationModule {
  readonly order: number;
  readonly migration: Migration;
}

function buildCoreMigrationRegistry(
  modules: ReadonlyArray<SQLiteCoreMigrationModule>
): ReadonlyArray<Migration> {
  const seenOrders = new Set<number>();
  const seenIds = new Set<string>();
  const seenChecksums = new Set<string>();
  const duplicateOrders = new Set<number>();
  const duplicateIds = new Set<string>();
  const duplicateChecksums = new Set<string>();

  for (const { order, migration } of modules) {
    if (seenOrders.has(order)) {
      duplicateOrders.add(order);
    } else {
      seenOrders.add(order);
    }

    if (seenIds.has(migration.id)) {
      duplicateIds.add(migration.id);
    } else {
      seenIds.add(migration.id);
    }

    if (seenChecksums.has(migration.checksum)) {
      duplicateChecksums.add(migration.checksum);
    } else {
      seenChecksums.add(migration.checksum);
    }
  }

  if (duplicateOrders.size || duplicateIds.size || duplicateChecksums.size) {
    const details: string[] = [];

    if (duplicateOrders.size) {
      details.push(`duplicate order(s): ${Array.from(duplicateOrders).sort((a, b) => a - b).join(', ')}`);
    }
    if (duplicateIds.size) {
      details.push(`duplicate id(s): ${Array.from(duplicateIds).sort().join(', ')}`);
    }
    if (duplicateChecksums.size) {
      details.push(`duplicate checksum(s): ${Array.from(duplicateChecksums).sort().join(', ')}`);
    }

    throw new Error(`[sqlite] Invalid core migration registry: ${details.join('; ')}`);
  }

  return Object.freeze(
    [...modules]
      .sort((a, b) => a.order - b.order || a.migration.id.localeCompare(b.migration.id))
      .map(({ migration }) => migration)
  );
}

export const SQLITE_CORE_MIGRATION_001_INITIAL: Migration = {
  id: '001_initial',
  up: `
      -- Projects table
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_url TEXT,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Tickets table
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'backlog',
        priority INTEGER NOT NULL DEFAULT 0,
        shard TEXT,
        category TEXT,
        allowed_paths TEXT, -- JSON array
        forbidden_paths TEXT, -- JSON array
        verification_commands TEXT, -- JSON array
        max_retries INTEGER DEFAULT 3,
        retry_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_project_status ON tickets(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_tickets_shard ON tickets(shard);

      -- Runs table
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        ticket_id TEXT REFERENCES tickets(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        type TEXT NOT NULL DEFAULT 'worker',
        status TEXT NOT NULL DEFAULT 'pending',
        iteration INTEGER NOT NULL DEFAULT 1,
        max_iterations INTEGER NOT NULL DEFAULT 10,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        metadata TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_runs_ticket ON runs(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
      CREATE INDEX IF NOT EXISTS idx_runs_type ON runs(type);

      -- Leases table
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'issued',
        expires_at TEXT NOT NULL,
        heartbeat_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_leases_ticket ON leases(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_leases_status ON leases(status);

      -- Run events table
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        type TEXT NOT NULL,
        data TEXT, -- JSON
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id);

      -- Artifacts table
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT,
        path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);

      -- Learnings table
      CREATE TABLE IF NOT EXISTS learnings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        ticket_id TEXT REFERENCES tickets(id),
        run_id TEXT REFERENCES runs(id),
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        promoted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project_id);
    `,
  checksum: 'initial-001-v1',
};

export const SQLITE_CORE_MIGRATION_002_RUN_STEPS: Migration = {
  id: '002_run_steps',
  up: `
      -- Run steps table for QA loop and future step-based runs
      -- Each step is a command/action within a run
      -- Supports retry attempts with full history
      CREATE TABLE IF NOT EXISTS run_steps (
        id               TEXT PRIMARY KEY,
        run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

        attempt          INTEGER NOT NULL DEFAULT 1,
        ordinal          INTEGER NOT NULL,

        name             TEXT NOT NULL,
        kind             TEXT NOT NULL DEFAULT 'command',

        status           TEXT NOT NULL DEFAULT 'queued',

        cmd              TEXT,
        cwd              TEXT,
        timeout_ms       INTEGER,

        exit_code        INTEGER,
        signal           TEXT,

        started_at_ms    INTEGER,
        ended_at_ms      INTEGER,
        duration_ms      INTEGER,

        stdout_path      TEXT,
        stderr_path      TEXT,
        stdout_bytes     INTEGER NOT NULL DEFAULT 0,
        stderr_bytes     INTEGER NOT NULL DEFAULT 0,
        stdout_truncated INTEGER NOT NULL DEFAULT 0,
        stderr_truncated INTEGER NOT NULL DEFAULT 0,
        stdout_tail      TEXT,
        stderr_tail      TEXT,

        error_message    TEXT,
        meta_json        TEXT,

        created_at_ms    INTEGER NOT NULL,
        updated_at_ms    INTEGER NOT NULL,

        CONSTRAINT run_steps_status_check CHECK (
          status IN ('queued','running','success','failed','skipped','canceled')
        ),
        CONSTRAINT run_steps_kind_check CHECK (
          kind IN ('command','llm_fix','git','internal')
        ),
        CONSTRAINT run_steps_stdout_trunc_check CHECK (stdout_truncated IN (0,1)),
        CONSTRAINT run_steps_stderr_trunc_check CHECK (stderr_truncated IN (0,1))
      );

      -- Unique indexes for data integrity
      CREATE UNIQUE INDEX IF NOT EXISTS run_steps_run_attempt_name_uniq
        ON run_steps(run_id, attempt, name);

      CREATE UNIQUE INDEX IF NOT EXISTS run_steps_run_attempt_ordinal_uniq
        ON run_steps(run_id, attempt, ordinal);

      -- Query indexes
      CREATE INDEX IF NOT EXISTS run_steps_run_attempt_idx
        ON run_steps(run_id, attempt);

      CREATE INDEX IF NOT EXISTS run_steps_run_status_idx
        ON run_steps(run_id, status);
    `,
  checksum: 'run-steps-002-v1',
};

const SQLITE_CORE_MIGRATION_MODULES: ReadonlyArray<SQLiteCoreMigrationModule> = [
  { order: 1, migration: SQLITE_CORE_MIGRATION_001_INITIAL },
  { order: 2, migration: SQLITE_CORE_MIGRATION_002_RUN_STEPS },
];

/**
 * Core SQLite schema migrations.
 *
 * These are simplified versions of the Postgres migrations,
 * adapted for SQLite syntax.
 */
export const SQLITE_CORE_MIGRATIONS: ReadonlyArray<Migration> =
  buildCoreMigrationRegistry(SQLITE_CORE_MIGRATION_MODULES);
