import type Database from 'better-sqlite3';
import type { Migration, MigrationResult } from '@promptwheel/core/db';
import { executeWithTransaction } from '../transactions/executor.js';

function assertUniqueMigrationSet(migrations: ReadonlyArray<Migration>): void {
  const seenIds = new Set<string>();
  const seenChecksums = new Set<string>();
  const duplicateIds = new Set<string>();
  const duplicateChecksums = new Set<string>();

  for (const migration of migrations) {
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

  if (duplicateIds.size || duplicateChecksums.size) {
    const details: string[] = [];
    if (duplicateIds.size) {
      details.push(`duplicate id(s): ${Array.from(duplicateIds).sort().join(', ')}`);
    }
    if (duplicateChecksums.size) {
      details.push(`duplicate checksum(s): ${Array.from(duplicateChecksums).sort().join(', ')}`);
    }
    throw new Error(`[sqlite] Invalid migration set: ${details.join('; ')}`);
  }
}

export interface SQLiteMigrationRunOptions {
  dryRun?: boolean;
  target?: string;
  verbose?: boolean;
}

/**
 * Apply SQLite migrations in order.
 *
 * Creates the migrations tracking table if needed and applies only
 * migrations that are not already recorded as applied.
 */
export async function runSqliteMigrations(
  db: Database.Database,
  migrations: ReadonlyArray<Migration>,
  options?: SQLiteMigrationRunOptions
): Promise<MigrationResult> {
  assertUniqueMigrationSet(migrations);

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    const existing = db.prepare('SELECT id FROM _migrations WHERE id = ?').get(migration.id);

    if (existing) {
      skipped.push(migration.id);
    } else if (options?.dryRun) {
      if (options.verbose) {
        console.log(`[sqlite] Would apply: ${migration.id}`);
      }
      applied.push(migration.id);
    } else {
      if (options?.verbose) {
        console.log(`[sqlite] Applying: ${migration.id}`);
      }

      await executeWithTransaction(db, async () => {
        db.exec(migration.up);
        db.prepare('INSERT INTO _migrations (id, checksum) VALUES (?, ?)').run(
          migration.id,
          migration.checksum
        );
      });
      applied.push(migration.id);
    }

    if (options?.target && migration.id === options.target) {
      break;
    }
  }

  return {
    applied,
    skipped,
    dryRun: options?.dryRun ?? false,
  };
}
