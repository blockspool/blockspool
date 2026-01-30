/**
 * @blockspool/sqlite
 *
 * SQLite adapter for BlockSpool.
 * Use this for zero-config local development.
 *
 * Features:
 * - No setup required - auto-creates database
 * - WAL mode for concurrency
 * - Works offline
 * - Stores data in ~/.blockspool/data.db by default
 */

export { SQLiteAdapter, createSQLiteAdapter } from './adapter.js';
