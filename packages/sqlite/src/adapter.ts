/**
 * SQLite adapter implementation
 *
 * Uses better-sqlite3 for synchronous, fast SQLite operations.
 * This is the zero-config adapter for individual developers.
 *
 * Key differences from Postgres:
 * - Synchronous API (better-sqlite3 is sync)
 * - WAL mode for better concurrency
 * - Single-writer pattern (SQLite limitation)
 * - No RETURNING * in older SQLite versions
 * - Different parameter placeholder syntax ($1 → ?)
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  DatabaseAdapter,
  DatabaseConfig,
  MigrationResult,
  QueryLogConfig,
  QueryResult,
  QueryStats,
  TransactionClient,
} from '@promptwheel/core/db';
import { SQLITE_CORE_MIGRATIONS } from './migrations/core.js';
import { runSqliteMigrations } from './migrations/runner.js';
import { createSqlitePlaceholderCompiler } from './sql/placeholder-rewrite.js';
import { executeSqliteQuery, executeWithTransaction } from './transactions/executor.js';

/**
 * Query observer for classification, logging, and stats.
 */
class SQLiteQueryObserver {
  private logConfig: QueryLogConfig = {
    logAll: false,
    slowQueryThresholdMs: 50,
    logParams: false,
  };

  private stats: QueryStats = {
    totalQueries: 0,
    totalErrors: 0,
    totalDurationMs: 0,
    byType: {},
  };

  getQueryType(text: string): string {
    const trimmed = text.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) return 'SELECT';
    if (trimmed.startsWith('INSERT')) return 'INSERT';
    if (trimmed.startsWith('UPDATE')) return 'UPDATE';
    if (trimmed.startsWith('DELETE')) return 'DELETE';
    if (trimmed.startsWith('BEGIN') || trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK')) {
      return 'TRANSACTION';
    }
    if (trimmed.startsWith('CREATE') || trimmed.startsWith('ALTER') || trimmed.startsWith('DROP')) {
      return 'DDL';
    }
    return 'OTHER';
  }

  recordQuery(
    text: string,
    params: unknown[] | undefined,
    queryType: string,
    durationMs: number,
    isError: boolean,
  ): void {
    this.stats.totalQueries++;
    this.stats.totalDurationMs += durationMs;
    if (isError) {
      this.stats.totalErrors++;
    }

    if (!this.stats.byType[queryType]) {
      this.stats.byType[queryType] = { count: 0, errors: 0, durationMs: 0 };
    }

    const typeStats = this.stats.byType[queryType];
    typeStats.count++;
    typeStats.durationMs += durationMs;
    if (isError) {
      typeStats.errors++;
      return;
    }

    const shouldLog =
      this.logConfig.logAll || durationMs >= this.logConfig.slowQueryThresholdMs;
    if (!shouldLog) return;

    const paramInfo = this.logConfig.logParams && params?.length
      ? ` params=${JSON.stringify(params)}`
      : '';
    const slowTag = durationMs >= this.logConfig.slowQueryThresholdMs ? ' [SLOW]' : '';
    console.log(`[sqlite]${slowTag} ${durationMs}ms: ${text.slice(0, 100)}${paramInfo}`);
  }

  configureLogging(config: Partial<QueryLogConfig>): void {
    this.logConfig = { ...this.logConfig, ...config };
  }

  getStatsSnapshot(): QueryStats {
    return {
      ...this.stats,
      byType: Object.fromEntries(
        Object.entries(this.stats.byType).map(([type, typeStats]) => [type, { ...typeStats }]),
      ),
    };
  }

  resetStats(): void {
    this.stats = {
      totalQueries: 0,
      totalErrors: 0,
      totalDurationMs: 0,
      byType: {},
    };
  }
}

/**
 * SQLite adapter for PromptWheel
 *
 * Features:
 * - WAL mode for better concurrency
 * - Auto-creates database directory
 * - Converts Postgres-style $1 params to SQLite ? params
 * - Delegates schema migrations to a dedicated runner
 */
export class SQLiteAdapter implements DatabaseAdapter {
  readonly name = 'sqlite';
  private db: Database.Database | null = null;
  private dbPath: string;
  private observer = new SQLiteQueryObserver();
  private placeholderCompiler = createSqlitePlaceholderCompiler();

  constructor(private config: DatabaseConfig) {
    // Parse database path from URL
    this.dbPath = this.parsePath(config.url);
  }

  get connected(): boolean {
    return this.db !== null && this.db.open;
  }

  /**
   * Parse database path from various URL formats
   */
  private parsePath(url: string): string {
    if (url.startsWith('sqlite://')) {
      return url.slice('sqlite://'.length);
    }
    if (url.startsWith('file:')) {
      return url.slice('file:'.length);
    }
    // Assume it's a direct path
    return url;
  }

  /**
   * Ensure the database directory exists
   */
  private ensureDirectory(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Get or create the database connection
   */
  private getDb(): Database.Database {
    if (!this.db) {
      this.ensureDirectory();

      this.db = new Database(this.dbPath);

      // Enable WAL mode for better concurrency
      if (this.config.walMode !== false) {
        this.db.pragma('journal_mode = WAL');
      }

      // Other performance pragmas
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = -64000'); // 64MB cache
      this.db.pragma('foreign_keys = ON');
    }
    return this.db;
  }

  private executeQuery<T = Record<string, unknown>>(
    db: Database.Database,
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return executeSqliteQuery<T>(db, text, params, {
      getQueryType: (queryText) => this.observer.getQueryType(queryText),
      rewritePlaceholders: (queryText, queryParams) => this.placeholderCompiler.rewrite(queryText, queryParams),
      recordQuery: (queryText, queryParams, queryType, durationMs, isError) => {
        this.observer.recordQuery(queryText, queryParams, queryType, durationMs, isError);
      },
    });
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.executeQuery<T>(this.getDb(), text, params);
  }

  async withTransaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T> {
    const db = this.getDb();

    // SQLite transactions are synchronous with better-sqlite3
    // But we wrap in async for interface compatibility
    const txClient: TransactionClient = {
      query: async <R = Record<string, unknown>>(
        text: string,
        params?: unknown[]
      ): Promise<QueryResult<R>> => {
        return this.executeQuery<R>(db, text, params);
      },
    };

    return executeWithTransaction(db, () => fn(txClient), { mode: 'IMMEDIATE' });
  }

  async migrate(options?: {
    dryRun?: boolean;
    target?: string;
    verbose?: boolean;
  }): Promise<MigrationResult> {
    const db = this.getDb();
    return runSqliteMigrations(db, SQLITE_CORE_MIGRATIONS, options);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  configureLogging(config: Partial<QueryLogConfig>): void {
    this.observer.configureLogging(config);
  }

  getStats(): Readonly<QueryStats> {
    return this.observer.getStatsSnapshot();
  }

  resetStats(): void {
    this.observer.resetStats();
  }
}

/**
 * Create a SQLite adapter
 *
 * @param config - Database configuration
 * @returns Initialized SQLite adapter
 */
export async function createSQLiteAdapter(config: DatabaseConfig): Promise<SQLiteAdapter> {
  const adapter = new SQLiteAdapter(config);
  // Run migrations to ensure schema exists
  await adapter.migrate({ verbose: false });
  return adapter;
}
