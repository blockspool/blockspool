import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { QueryResult } from '@promptwheel/core/db';

export type SQLiteTransactionMode = 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE';

export interface ExecuteTransactionOptions {
  mode?: SQLiteTransactionMode;
}

export interface SQLiteQueryExecutionHooks {
  getQueryType(text: string): string;
  rewritePlaceholders(text: string, params?: unknown[]): { sql: string; values: unknown[] };
  recordQuery(
    text: string,
    params: unknown[] | undefined,
    queryType: string,
    durationMs: number,
    isError: boolean,
  ): void;
}

interface TransactionContext {
  db: Database.Database;
}

const transactionContext = new AsyncLocalStorage<TransactionContext>();
const savepointCounters = new WeakMap<Database.Database, number>();

function getBeginStatement(mode: SQLiteTransactionMode | undefined): string {
  if (mode === 'IMMEDIATE') return 'BEGIN IMMEDIATE';
  if (mode === 'EXCLUSIVE') return 'BEGIN EXCLUSIVE';
  return 'BEGIN';
}

function nextSavepointName(db: Database.Database): string {
  const nextId = (savepointCounters.get(db) ?? 0) + 1;
  savepointCounters.set(db, nextId);
  return `pw_tx_sp_${nextId}`;
}

export async function executeSqliteQuery<T = Record<string, unknown>>(
  db: Database.Database,
  text: string,
  params: unknown[] | undefined,
  hooks: SQLiteQueryExecutionHooks,
): Promise<QueryResult<T>> {
  const queryType = hooks.getQueryType(text);
  const { sql, values } = hooks.rewritePlaceholders(text, params);
  const start = Date.now();

  try {
    let rows: T[] = [];
    let rowCount: number | null = null;

    // Use run() for INSERT/UPDATE/DELETE, all() for SELECT, PRAGMA, and RETURNING queries
    const hasReturning = /\bRETURNING\s+/i.test(text);
    if (queryType === 'SELECT' || hasReturning || text.trim().toUpperCase().startsWith('PRAGMA')) {
      const stmt = db.prepare(sql);
      rows = stmt.all(...values) as T[];
      rowCount = rows.length;
    } else {
      const stmt = db.prepare(sql);
      const result = stmt.run(...values);
      rowCount = result.changes;
    }

    const durationMs = Date.now() - start;
    hooks.recordQuery(text, params, queryType, durationMs, false);

    return { rows, rowCount };
  } catch (error) {
    const durationMs = Date.now() - start;
    hooks.recordQuery(text, params, queryType, durationMs, true);
    throw error;
  }
}

export async function executeWithTransaction<T>(
  db: Database.Database,
  fn: () => Promise<T>,
  options?: ExecuteTransactionOptions
): Promise<T> {
  const currentContext = transactionContext.getStore();

  if (currentContext?.db === db) {
    const savepointName = nextSavepointName(db);

    db.exec(`SAVEPOINT ${savepointName}`);
    try {
      const result = await fn();
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      throw error;
    }
  }

  db.exec(getBeginStatement(options?.mode));
  return transactionContext.run({ db }, async () => {
    try {
      const result = await fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}
