import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseAdapter } from '@promptwheel/core';
import type { Project } from '@promptwheel/core';
import { repos } from '@promptwheel/core';
import { RunManager } from './run-manager.js';
import type { EventType } from './types.js';
import { recordDedupEntry } from './dedup-memory.js';
import {
  recordTicketOutcome as recordTicketOutcomeCore,
} from '@promptwheel/core/sectors/shared';
import type { SectorState } from '@promptwheel/core/sectors/shared';

// ---------------------------------------------------------------------------
// EventContext — shared context for all handlers
// ---------------------------------------------------------------------------

export interface EventContext {
  run: RunManager;
  db: DatabaseAdapter;
  project?: Project;
}

// ---------------------------------------------------------------------------
// ProcessResult
// ---------------------------------------------------------------------------

export interface ProcessResult {
  processed: boolean;
  phase_changed: boolean;
  new_phase?: string;
  message: string;
}

export interface EventPayloadValidationSuccess {
  ok: true;
  payload: Record<string, unknown>;
}

export interface EventPayloadValidationFailure {
  ok: false;
  error: string;
}

export type EventPayloadValidation = EventPayloadValidationSuccess | EventPayloadValidationFailure;

const PLAN_ACTIONS = new Set(['create', 'modify', 'delete']);
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
type PlanAction = 'create' | 'modify' | 'delete';

function isPlanAction(value: string): value is PlanAction {
  return value === 'create' || value === 'modify' || value === 'delete';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function toNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function toBooleanOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    return undefined;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  return undefined;
}

export function toStringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    items.push(item);
  }
  return items;
}

function invalid(type: EventType, message: string): EventPayloadValidationFailure {
  return { ok: false, error: `Invalid ${type} payload: ${message}` };
}

function toRecordArrayOrUndefined(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    records.push(item);
  }
  return records;
}

export function validateAndSanitizeEventPayload(
  type: EventType,
  payload: Record<string, unknown>,
): EventPayloadValidation {
  const sanitized: Record<string, unknown> = { ...payload };
  if ('ticket_id' in payload) {
    const ticketId = payload['ticket_id'];
    if (typeof ticketId === 'string') {
      sanitized['ticket_id'] = ticketId;
    } else if (typeof ticketId === 'number' && Number.isFinite(ticketId)) {
      sanitized['ticket_id'] = String(ticketId);
    } else {
      return invalid(type, '`ticket_id` must be a string or number');
    }
  }

  switch (type) {
    case 'SCOUT_OUTPUT': {
      if ('explored_dirs' in payload) {
        const exploredDirs = toStringArrayOrUndefined(payload['explored_dirs']);
        if (!exploredDirs) return invalid(type, '`explored_dirs` must be an array of strings');
        sanitized['explored_dirs'] = exploredDirs;
      }

      if ('proposals' in payload) {
        const proposals = toRecordArrayOrUndefined(payload['proposals']);
        if (!proposals) return invalid(type, '`proposals` must be an array of objects');
        sanitized['proposals'] = proposals;
      }

      if ('reviewed_proposals' in payload) {
        const reviewedProposals = toRecordArrayOrUndefined(payload['reviewed_proposals']);
        if (!reviewedProposals) return invalid(type, '`reviewed_proposals` must be an array of objects');
        sanitized['reviewed_proposals'] = reviewedProposals;
      }

      if ('text' in payload) {
        const text = toStringOrUndefined(payload['text']);
        if (text === undefined) return invalid(type, '`text` must be a string');
        sanitized['text'] = text;
      }

      if ('exploration_summary' in payload) {
        const summary = toStringOrUndefined(payload['exploration_summary']);
        if (summary === undefined) return invalid(type, '`exploration_summary` must be a string');
        sanitized['exploration_summary'] = summary;
      }

      if ('sector_reclassification' in payload) {
        const raw = payload['sector_reclassification'];
        if (raw !== undefined) {
          if (!isRecord(raw)) return invalid(type, '`sector_reclassification` must be an object');
          const reclass: Record<string, unknown> = { ...raw };
          if ('production' in raw) {
            const production = toBooleanOrUndefined(raw['production']);
            if (production === undefined) return invalid(type, '`sector_reclassification.production` must be boolean');
            reclass['production'] = production;
          }
          if ('confidence' in raw) {
            const confidence = toStringOrUndefined(raw['confidence']);
            if (!confidence || !RISK_LEVELS.has(confidence)) {
              return invalid(type, '`sector_reclassification.confidence` must be low, medium, or high');
            }
            reclass['confidence'] = confidence;
          }
          sanitized['sector_reclassification'] = reclass;
        }
      }
      return { ok: true, payload: sanitized };
    }

    case 'PROPOSALS_REVIEWED': {
      const reviewedProposals = toRecordArrayOrUndefined(payload['reviewed_proposals']);
      if (!reviewedProposals) return invalid(type, '`reviewed_proposals` is required and must be an array of objects');

      const cleanItems: Record<string, unknown>[] = [];
      for (const item of reviewedProposals) {
        const clean: Record<string, unknown> = {};

        if ('title' in item) {
          const title = toStringOrUndefined(item['title']);
          if (title === undefined) return invalid(type, '`reviewed_proposals[].title` must be a string');
          clean['title'] = title;
        }
        if ('confidence' in item) {
          const confidence = toNumberOrUndefined(item['confidence']);
          if (confidence === undefined) return invalid(type, '`reviewed_proposals[].confidence` must be a number');
          clean['confidence'] = confidence;
        }
        if ('impact_score' in item) {
          const impactScore = toNumberOrUndefined(item['impact_score']);
          if (impactScore === undefined) return invalid(type, '`reviewed_proposals[].impact_score` must be a number');
          clean['impact_score'] = impactScore;
        }
        if ('review_note' in item) {
          const reviewNote = toStringOrUndefined(item['review_note']);
          if (reviewNote === undefined) return invalid(type, '`reviewed_proposals[].review_note` must be a string');
          clean['review_note'] = reviewNote;
        }

        cleanItems.push({ ...item, ...clean });
      }

      sanitized['reviewed_proposals'] = cleanItems;
      return { ok: true, payload: sanitized };
    }

    case 'PROPOSALS_FILTERED':
    case 'QA_PASSED':
      return { ok: true, payload: sanitized };

    case 'PLAN_SUBMITTED': {
      const filesToTouchRaw = Array.isArray(payload['files_to_touch']) ? payload['files_to_touch']
        : Array.isArray(payload['files']) ? payload['files']
        : Array.isArray(payload['touched_files']) ? payload['touched_files']
        : undefined;

      if (
        ('files_to_touch' in payload && !Array.isArray(payload['files_to_touch']))
        || ('files' in payload && !Array.isArray(payload['files']))
        || ('touched_files' in payload && !Array.isArray(payload['touched_files']))
      ) {
        return invalid(type, '`files_to_touch`/`files`/`touched_files` must be arrays');
      }

      const filesToTouch: Array<{ path: string; action: PlanAction; reason: string }> = [];
      for (const file of filesToTouchRaw ?? []) {
        if (typeof file === 'string') {
          filesToTouch.push({ path: file, action: 'modify', reason: '' });
          continue;
        }
        if (!isRecord(file)) {
          return invalid(type, '`files_to_touch[]` entries must be strings or objects');
        }
        const pathValue = toStringOrUndefined(file['path']);
        if (!pathValue) return invalid(type, '`files_to_touch[].path` must be a non-empty string');
        const actionValue = 'action' in file ? toStringOrUndefined(file['action']) : 'modify';
        if (!actionValue || !PLAN_ACTIONS.has(actionValue) || !isPlanAction(actionValue)) {
          return invalid(type, '`files_to_touch[].action` must be create, modify, or delete');
        }
        const reasonValue = 'reason' in file ? toStringOrUndefined(file['reason']) : '';
        if (reasonValue === undefined) return invalid(type, '`files_to_touch[].reason` must be a string');
        filesToTouch.push({ path: pathValue, action: actionValue, reason: reasonValue });
      }
      sanitized['files_to_touch'] = filesToTouch;

      if ('expected_tests' in payload) {
        const expectedTests = toStringArrayOrUndefined(payload['expected_tests']);
        if (!expectedTests) return invalid(type, '`expected_tests` must be an array of strings');
        sanitized['expected_tests'] = expectedTests;
      }

      if ('risk_level' in payload) {
        const riskLevel = toStringOrUndefined(payload['risk_level']);
        if (!riskLevel || !RISK_LEVELS.has(riskLevel)) {
          return invalid(type, '`risk_level` must be low, medium, or high');
        }
        sanitized['risk_level'] = riskLevel;
      }

      if ('estimated_lines' in payload) {
        const estimatedLines = toNumberOrUndefined(payload['estimated_lines']);
        if (estimatedLines === undefined || estimatedLines < 0) {
          return invalid(type, '`estimated_lines` must be a non-negative number');
        }
        sanitized['estimated_lines'] = estimatedLines;
      }

      return { ok: true, payload: sanitized };
    }

    case 'TICKET_RESULT': {
      const status = toStringOrUndefined(payload['status']);
      if (!status) return invalid(type, '`status` is required and must be a string');
      sanitized['status'] = status;

      if ('changed_files' in payload) {
        const changedFiles = toStringArrayOrUndefined(payload['changed_files']);
        if (!changedFiles) return invalid(type, '`changed_files` must be an array of strings');
        sanitized['changed_files'] = changedFiles;
      } else {
        sanitized['changed_files'] = [];
      }

      if ('lines_added' in payload) {
        const linesAdded = toNumberOrUndefined(payload['lines_added']);
        if (linesAdded === undefined || linesAdded < 0) return invalid(type, '`lines_added` must be a non-negative number');
        sanitized['lines_added'] = linesAdded;
      } else {
        sanitized['lines_added'] = 0;
      }

      if ('lines_removed' in payload) {
        const linesRemoved = toNumberOrUndefined(payload['lines_removed']);
        if (linesRemoved === undefined || linesRemoved < 0) return invalid(type, '`lines_removed` must be a non-negative number');
        sanitized['lines_removed'] = linesRemoved;
      } else {
        sanitized['lines_removed'] = 0;
      }

      if ('diff' in payload && payload['diff'] !== null && typeof payload['diff'] !== 'string') {
        return invalid(type, '`diff` must be a string or null');
      }
      if ('stdout' in payload && typeof payload['stdout'] !== 'string') {
        return invalid(type, '`stdout` must be a string');
      }
      if ('reason' in payload && typeof payload['reason'] !== 'string') {
        return invalid(type, '`reason` must be a string');
      }
      return { ok: true, payload: sanitized };
    }

    case 'QA_COMMAND_RESULT': {
      const command = toStringOrUndefined(payload['command']);
      if (!command) return invalid(type, '`command` is required and must be a string');
      sanitized['command'] = command;

      const success = toBooleanOrUndefined(payload['success']);
      if (success === undefined) return invalid(type, '`success` is required and must be boolean');
      sanitized['success'] = success;

      if ('output' in payload) {
        const output = toStringOrUndefined(payload['output']);
        if (output === undefined) return invalid(type, '`output` must be a string');
        sanitized['output'] = output;
      } else {
        sanitized['output'] = '';
      }

      if ('durationMs' in payload) {
        const durationMs = toNumberOrUndefined(payload['durationMs']);
        if (durationMs === undefined || durationMs < 0) return invalid(type, '`durationMs` must be a non-negative number');
        sanitized['durationMs'] = durationMs;
      } else {
        sanitized['durationMs'] = 0;
      }

      if ('timedOut' in payload) {
        const timedOut = toBooleanOrUndefined(payload['timedOut']);
        if (timedOut === undefined) return invalid(type, '`timedOut` must be boolean');
        sanitized['timedOut'] = timedOut;
      } else {
        sanitized['timedOut'] = false;
      }

      return { ok: true, payload: sanitized };
    }

    case 'QA_FAILED': {
      if ('failed_commands' in payload) {
        const failedCommands = payload['failed_commands'];
        if (typeof failedCommands === 'string') {
          sanitized['failed_commands'] = [failedCommands];
        } else {
          const commandArray = toStringArrayOrUndefined(failedCommands);
          if (!commandArray) return invalid(type, '`failed_commands` must be a string or array of strings');
          sanitized['failed_commands'] = commandArray;
        }
      }

      if ('command' in payload) {
        const command = toStringOrUndefined(payload['command']);
        if (command === undefined) return invalid(type, '`command` must be a string');
        sanitized['command'] = command;
      }

      if ('error' in payload) {
        const error = toStringOrUndefined(payload['error']);
        if (error === undefined) return invalid(type, '`error` must be a string');
        sanitized['error'] = error;
      }

      if ('output' in payload) {
        const output = toStringOrUndefined(payload['output']);
        if (output === undefined) return invalid(type, '`output` must be a string');
        sanitized['output'] = output;
      }
      return { ok: true, payload: sanitized };
    }

    case 'PR_CREATED': {
      if ('url' in payload && typeof payload['url'] !== 'string') {
        return invalid(type, '`url` must be a string');
      }
      if ('branch' in payload && typeof payload['branch'] !== 'string') {
        return invalid(type, '`branch` must be a string');
      }
      return { ok: true, payload: sanitized };
    }

    case 'USER_OVERRIDE': {
      if ('hint' in payload) {
        const hint = toStringOrUndefined(payload['hint']);
        if (hint === undefined) return invalid(type, '`hint` must be a string');
        sanitized['hint'] = hint;
      }
      if ('cancel' in payload) {
        const cancel = toBooleanOrUndefined(payload['cancel']);
        if (cancel === undefined) return invalid(type, '`cancel` must be boolean');
        sanitized['cancel'] = cancel;
      }
      if ('skip_review' in payload) {
        const skipReview = toBooleanOrUndefined(payload['skip_review']);
        if (skipReview === undefined) return invalid(type, '`skip_review` must be boolean');
        sanitized['skip_review'] = skipReview;
      }
      return { ok: true, payload: sanitized };
    }

    default:
      return { ok: true, payload: sanitized };
  }
}

// ---------------------------------------------------------------------------
// Helpers — shared sector & dedup recording
// ---------------------------------------------------------------------------

/** Atomic write: write to .tmp then rename, preventing corruption on crash */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/** Load sectors.json, return null if missing/invalid. */
export function loadSectorsState(rootPath: string): { state: SectorState; filePath: string } | null {
  try {
    const filePath = path.join(rootPath, '.promptwheel', 'sectors.json');
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data?.version !== 2 || !Array.isArray(data.sectors)) return null;
    return { state: data as SectorState, filePath };
  } catch (err) {
    console.warn(`[promptwheel] loadSectorsState: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function recordSectorOutcome(
  rootPath: string,
  sectorPath: string | undefined,
  outcome: 'success' | 'failure',
): void {
  if (!sectorPath) return;
  try {
    const loaded = loadSectorsState(rootPath);
    if (!loaded) return;
    recordTicketOutcomeCore(loaded.state, sectorPath, outcome === 'success');
    atomicWriteJsonSync(loaded.filePath, loaded.state);
  } catch (err) {
    console.warn(`[promptwheel] recordSectorOutcome: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function recordTicketDedup(
  db: DatabaseAdapter,
  rootPath: string,
  ticketId: string | null,
  completed: boolean,
  reason?: string,
  /** Pass a pre-fetched ticket to avoid a redundant DB lookup */
  prefetchedTicket?: { title: string } | null,
): Promise<void> {
  if (!ticketId) return;
  try {
    const ticket = prefetchedTicket ?? await repos.tickets.getById(db, ticketId);
    if (ticket) {
      recordDedupEntry(rootPath, ticket.title, completed, reason);
    }
  } catch (err) {
    console.warn(`[promptwheel] recordTicketDedup: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Extract a normalized error signature from raw error output.
 * Captures the first recognizable error pattern (TypeError, SyntaxError, assertion, etc.)
 * and truncates to 120 chars for storage.
 */
export function extractErrorSignature(errorOutput: string): string | undefined {
  if (!errorOutput) return undefined;
  // Match common error patterns
  const patterns = [
    /(?:TypeError|ReferenceError|SyntaxError|RangeError|Error):\s*[^\n]{1,100}/,
    /AssertionError:\s*[^\n]{1,100}/i,
    /FAIL(?:ED)?[:\s]+[^\n]{1,80}/i,
    /error\[E\d+\]:\s*[^\n]{1,80}/i,  // Rust errors
    /panic:\s*[^\n]{1,80}/,             // Go panics
    /Exception[:\s]+[^\n]{1,80}/i,      // Java/Python exceptions
  ];
  for (const p of patterns) {
    const match = errorOutput.match(p);
    if (match) return match[0].slice(0, 120);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// QA error classification
// ---------------------------------------------------------------------------

export type QaErrorClass = 'environment' | 'timeout' | 'code' | 'unknown';

/**
 * Classify a QA error to determine retry strategy.
 * - environment: permission denied, missing tools, env vars — don't retry (will never pass)
 * - timeout: command timed out — retry once (transient)
 * - code: test failures, type errors, syntax errors — full retries (agent can fix)
 * - unknown: can't classify — full retries (default)
 */
export function classifyQaError(errorOutput: string): QaErrorClass {
  const lower = errorOutput.toLowerCase();
  // Environment / permission issues — unrecoverable without human intervention
  if (/permission denied|eacces|eperm/i.test(errorOutput)) return 'environment';
  if (/command not found|enoent.*spawn/i.test(errorOutput)) return 'environment';
  if (/missing.*(env|variable|credential|token|key|secret)/i.test(lower)) return 'environment';
  if (/econnrefused|enotfound|cannot connect/i.test(errorOutput)) return 'environment';
  // Timeout — transient, worth one retry
  if (/timed?\s*out|timeout|etimedout/i.test(errorOutput)) return 'timeout';
  if (/killed.*signal|sigterm|sigkill/i.test(lower)) return 'timeout';
  // Code errors — agent can fix these
  if (/syntaxerror|typeerror|referenceerror|rangeerror/i.test(errorOutput)) return 'code';
  if (/assertion|expect|fail|error\[/i.test(lower)) return 'code';
  if (/tsc.*error|type.*not assignable/i.test(lower)) return 'code';
  return 'unknown';
}

/** Max retries per error class */
export function maxRetriesForClass(errorClass: QaErrorClass): number {
  switch (errorClass) {
    case 'environment': return 1;  // One retry in case it was a race, then give up
    case 'timeout': return 2;      // Transient — try twice
    case 'code': return 3;         // Agent can fix — full retries
    case 'unknown': return 3;      // Default — full retries
  }
}
