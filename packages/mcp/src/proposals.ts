/**
 * Proposal filtering, dedup, scoring, and ticket creation.
 *
 * Used by the event processor when SCOUT_OUTPUT is ingested,
 * and by the blockspool_submit_proposals tool.
 */

import type { DatabaseAdapter, TicketCategory } from '@blockspool/core';
import { repos } from '@blockspool/core';
import { RunManager } from './run-manager.js';

// ---------------------------------------------------------------------------
// Proposal schema
// ---------------------------------------------------------------------------

export interface RawProposal {
  category?: string;
  title?: string;
  description?: string;
  acceptance_criteria?: string[];
  verification_commands?: string[];
  allowed_paths?: string[];
  files?: string[];
  confidence?: number;
  impact_score?: number;
  rationale?: string;
  estimated_complexity?: string;
  risk?: string;
  touched_files_estimate?: number;
  rollback_note?: string;
}

export interface ValidatedProposal {
  category: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  verification_commands: string[];
  allowed_paths: string[];
  files: string[];
  confidence: number;
  impact_score: number;
  rationale: string;
  estimated_complexity: string;
  risk: string;
  touched_files_estimate: number;
  rollback_note: string;
}

export interface FilterResult {
  accepted: ValidatedProposal[];
  rejected: Array<{ proposal: RawProposal; reason: string }>;
  created_ticket_ids: string[];
}

const REQUIRED_FIELDS: (keyof ValidatedProposal)[] = [
  'category', 'title', 'description', 'allowed_paths',
  'files', 'confidence', 'verification_commands',
  'risk', 'touched_files_estimate', 'rollback_note',
];

// ---------------------------------------------------------------------------
// Main entry: filter + create tickets
// ---------------------------------------------------------------------------

export async function filterAndCreateTickets(
  run: RunManager,
  db: DatabaseAdapter,
  rawProposals: RawProposal[],
): Promise<FilterResult> {
  const s = run.require();
  const rejected: FilterResult['rejected'] = [];

  // Step 1: Schema validation
  const valid: ValidatedProposal[] = [];
  for (const raw of rawProposals) {
    const missing = validateSchema(raw);
    if (missing) {
      rejected.push({ proposal: raw, reason: `Missing fields: ${missing}` });
      continue;
    }
    valid.push(normalizeProposal(raw));
  }

  // Step 2: Confidence filter
  const afterConfidence = valid.filter(p => {
    if (p.confidence < s.min_confidence) {
      rejected.push({ proposal: p, reason: `Confidence ${p.confidence} below min ${s.min_confidence}` });
      return false;
    }
    return true;
  });

  // Step 3: Category trust ladder
  const allowedCategories = new Set(s.categories);
  const afterCategory = afterConfidence.filter(p => {
    if (!allowedCategories.has(p.category)) {
      rejected.push({ proposal: p, reason: `Category '${p.category}' not in trust ladder` });
      return false;
    }
    return true;
  });

  // Step 4: Dedup against existing tickets (title similarity)
  const existingTickets = await repos.tickets.listByProject(db, s.project_id);
  const existingTitles = existingTickets.map(t => t.title);
  const afterDedup = afterCategory.filter(p => {
    const isDupe = existingTitles.some(t => titleSimilarity(t, p.title) >= 0.6);
    if (isDupe) {
      rejected.push({ proposal: p, reason: 'Duplicate of existing ticket (title similarity >= 0.6)' });
      return false;
    }
    return true;
  });

  // Also dedup within the batch
  const uniqueByTitle: ValidatedProposal[] = [];
  for (const p of afterDedup) {
    const isDupeInBatch = uniqueByTitle.some(q => titleSimilarity(q.title, p.title) >= 0.6);
    if (isDupeInBatch) {
      rejected.push({ proposal: p, reason: 'Duplicate within batch (title similarity >= 0.6)' });
      continue;
    }
    uniqueByTitle.push(p);
  }

  // Step 5: Score and cap
  const scored = uniqueByTitle
    .map(p => ({
      proposal: p,
      score: (p.impact_score ?? 5) * p.confidence,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, s.max_proposals_per_scout);

  const accepted = scored.map(s => s.proposal);

  // Step 6: Create tickets
  const ticketInputs = accepted.map(p => ({
    projectId: s.project_id,
    title: p.title,
    description: formatDescription(p),
    status: 'ready' as const,
    priority: Math.round((p.impact_score ?? 5) * p.confidence / 10),
    category: p.category as TicketCategory,
    allowedPaths: p.allowed_paths,
    verificationCommands: p.verification_commands,
  }));

  let createdIds: string[] = [];
  if (ticketInputs.length > 0) {
    const created = await repos.tickets.createMany(db, ticketInputs);
    createdIds = created.map(t => t.id);

    run.appendEvent('TICKETS_CREATED', {
      count: created.length,
      ids: createdIds,
      titles: accepted.map(p => p.title),
    });
  }

  run.appendEvent('PROPOSALS_FILTERED', {
    submitted: rawProposals.length,
    valid: valid.length,
    after_confidence: afterConfidence.length,
    after_category: afterCategory.length,
    after_dedup: uniqueByTitle.length,
    accepted: accepted.length,
    rejected_count: rejected.length,
  });

  return { accepted, rejected, created_ticket_ids: createdIds };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validateSchema(raw: RawProposal): string | null {
  const missing: string[] = [];

  if (!raw.category || typeof raw.category !== 'string') missing.push('category');
  if (!raw.title || typeof raw.title !== 'string') missing.push('title');
  if (!raw.description || typeof raw.description !== 'string') missing.push('description');
  if (!Array.isArray(raw.allowed_paths)) missing.push('allowed_paths');
  if (!Array.isArray(raw.files)) missing.push('files');
  if (typeof raw.confidence !== 'number') missing.push('confidence');
  if (!Array.isArray(raw.verification_commands)) missing.push('verification_commands');
  if (!raw.risk || typeof raw.risk !== 'string') missing.push('risk');
  if (typeof raw.touched_files_estimate !== 'number') missing.push('touched_files_estimate');
  if (!raw.rollback_note || typeof raw.rollback_note !== 'string') missing.push('rollback_note');

  return missing.length > 0 ? missing.join(', ') : null;
}

function normalizeProposal(raw: RawProposal): ValidatedProposal {
  return {
    category: raw.category!,
    title: raw.title!,
    description: raw.description!,
    acceptance_criteria: raw.acceptance_criteria ?? [],
    verification_commands: raw.verification_commands ?? [],
    allowed_paths: raw.allowed_paths ?? [],
    files: raw.files ?? [],
    confidence: raw.confidence!,
    impact_score: raw.impact_score ?? 5,
    rationale: raw.rationale ?? '',
    estimated_complexity: raw.estimated_complexity ?? 'moderate',
    risk: raw.risk!,
    touched_files_estimate: raw.touched_files_estimate!,
    rollback_note: raw.rollback_note!,
  };
}

// ---------------------------------------------------------------------------
// Title similarity (Jaccard on bigrams, case-insensitive)
// ---------------------------------------------------------------------------

export function titleSimilarity(a: string, b: string): number {
  const bigramsA = bigrams(a.toLowerCase());
  const bigramsB = bigrams(b.toLowerCase());

  if (bigramsA.size === 0 && bigramsB.size === 0) return 1;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function bigrams(s: string): Set<string> {
  const result = new Set<string>();
  const cleaned = s.replace(/[^a-z0-9 ]/g, '').trim();
  for (let i = 0; i < cleaned.length - 1; i++) {
    result.add(cleaned.slice(i, i + 2));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Description formatter
// ---------------------------------------------------------------------------

function formatDescription(p: ValidatedProposal): string {
  const parts = [
    p.description,
    '',
    '## Acceptance Criteria',
    ...p.acceptance_criteria.map(c => `- ${c}`),
    '',
    '## Details',
    `**Risk:** ${p.risk}`,
    `**Complexity:** ${p.estimated_complexity}`,
    `**Confidence:** ${p.confidence}%`,
    `**Impact:** ${p.impact_score}/10`,
    `**Estimated files:** ${p.touched_files_estimate}`,
    '',
    '## Rollback',
    p.rollback_note,
  ];

  if (p.rationale) {
    parts.push('', '## Rationale', p.rationale);
  }

  if (p.files.length > 0) {
    parts.push('', '## Files', ...p.files.map(f => `- \`${f}\``));
  }

  return parts.join('\n');
}
