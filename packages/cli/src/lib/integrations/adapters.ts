import type { TicketProposal } from '@promptwheel/core/scout';
import { addLearning } from '../learnings.js';
import { addHint } from '../solo-hints.js';
import type { IntegrationResult } from './config.js';

/**
 * Convert raw MCP tool output to TicketProposal[].
 *
 * Expects the MCP tool to return:
 * ```json
 * { "proposals": [{ "title", "description", "files", "category", "confidence", "impact" }] }
 * ```
 */
export function toProposals(result: IntegrationResult): TicketProposal[] {
  const data = result.data as Record<string, unknown> | null;
  if (!data) return [];

  const raw = Array.isArray(data) ? data : (data.proposals as unknown[]);
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item, i) => ({
      id: `integration-${result.provider}-${Date.now()}-${i}`,
      title: String(item.title ?? `${result.provider} finding ${i + 1}`),
      description: String(item.description ?? ''),
      category: (item.category as TicketProposal['category']) ?? 'fix',
      confidence: typeof item.confidence === 'number' ? item.confidence : 50,
      impact_score: typeof item.impact === 'number' ? item.impact : (typeof item.impact_score === 'number' ? item.impact_score : 5),
      files: Array.isArray(item.files) ? item.files.map(String) : [],
      allowed_paths: Array.isArray(item.files) ? item.files.map(String) : (Array.isArray(item.allowed_paths) ? item.allowed_paths.map(String) : []),
      acceptance_criteria: Array.isArray(item.acceptance_criteria) ? item.acceptance_criteria.map(String) : [],
      verification_commands: Array.isArray(item.verification_commands) ? item.verification_commands.map(String) : [],
      rationale: String(item.rationale ?? item.description ?? ''),
      estimated_complexity: (item.estimated_complexity as TicketProposal['estimated_complexity']) ?? 'moderate',
    }));
}

/**
 * Convert raw MCP tool output to learnings and store them.
 *
 * Expects: `{ "learnings": [{ "text", "category"?, "tags"? }] }`
 */
export function toLearnings(data: unknown, repoRoot: string): void {
  if (!data || typeof data !== 'object') return;

  const obj = data as Record<string, unknown>;
  const raw = Array.isArray(obj) ? obj : (obj.learnings as unknown[]);
  if (!Array.isArray(raw)) return;

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const text = String(entry.text ?? '').slice(0, 200);
    if (!text) continue;

    addLearning(repoRoot, {
      text,
      category: (entry.category as 'pattern' | 'warning' | 'gotcha' | 'context') ?? 'context',
      source: { type: 'manual', detail: 'integration' },
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    });
  }
}

/**
 * Convert raw MCP tool output to nudges (hints) and store them.
 *
 * Expects: `{ "nudges": [{ "text" }] }` or `{ "nudges": ["text", ...] }`
 */
export function toNudges(data: unknown, repoRoot: string): void {
  if (!data || typeof data !== 'object') return;

  const obj = data as Record<string, unknown>;
  const raw = Array.isArray(obj) ? obj : (obj.nudges as unknown[]);
  if (!Array.isArray(raw)) return;

  for (const item of raw) {
    const text = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' ? String((item as Record<string, unknown>).text ?? '') : '');
    if (text) {
      addHint(repoRoot, text.slice(0, 500));
    }
  }
}
