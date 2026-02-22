/**
 * @promptwheel/sqlite
 *
 * SQLite adapter for PromptWheel.
 * Use this for zero-config local development.
 * Requires callers to provide `DatabaseConfig.url`.
 *
 * Features:
 * - No setup required - auto-creates database
 * - WAL mode for concurrency
 * - Works offline
 * - Uses a caller-provided database URL (`DatabaseConfig.url`)
 * - Default paths (for example, ~/.promptwheel/data.db) are chosen by higher-level callers
 */

export { SQLiteAdapter, createSQLiteAdapter } from './adapter.js';
