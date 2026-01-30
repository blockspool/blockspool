/**
 * @blockspool/core
 *
 * Core business logic and shared types for BlockSpool.
 * This package is open source (Apache-2.0) and provides:
 *
 * - Database adapter interface (works with Postgres or SQLite)
 * - Repository layer for data access
 * - Services for business logic orchestration
 * - Scout service for codebase analysis
 * - Shared type definitions
 * - Core business logic utilities
 */

// Database adapter
export * from './db/index.js';

// Repositories (namespaced)
export * as repos from './repos/index.js';
export type { Project, Ticket, TicketStatus, TicketCategory, Run, RunStatus, RunType } from './repos/index.js';

// Services (namespaced to avoid conflicts with scout)
export * as services from './services/index.js';
export type { ScoutDeps, ScoutRepoOptions, ScoutRepoResult, GitService, Logger } from './services/index.js';
export { scoutRepo, approveProposals } from './services/index.js';

// Scout (low-level scanning/analysis - namespaced)
export * as scout from './scout/index.js';

// Exec runner interface
export * from './exec/index.js';

// Utilities
export * from './utils/index.js';
