import type { EventContext, ProcessResult } from './event-helpers.js';
import { isRecord, toBooleanOrUndefined, toNumberOrUndefined, toStringArrayOrUndefined, toStringOrUndefined } from './event-helpers.js';
import { repos, SCOUT_DEFAULTS } from '@promptwheel/core';
import { filterAndCreateTickets, parseReviewedProposals } from './proposals.js';
import type { RawProposal } from './proposals.js';
import { addLearning, extractTags } from './learnings.js';

const MAX_SCOUT_RETRIES = SCOUT_DEFAULTS.MAX_SCOUT_RETRIES;
const MAX_BARREN_CYCLES = SCOUT_DEFAULTS.MAX_BARREN_CYCLES;

function isRawProposal(value: unknown): value is RawProposal {
  return isRecord(value);
}

export async function handleScoutOutput(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'SCOUT') {
    return { processed: true, phase_changed: false, message: 'Scout output outside SCOUT phase, ignored' };
  }

  // Track explored directories for rotation across cycles
  const exploredDirs = toStringArrayOrUndefined(payload['explored_dirs']) ?? [];
  if (exploredDirs.length > 0) {
    for (const dir of exploredDirs) {
      if (!s.scouted_dirs.includes(dir)) {
        s.scouted_dirs.push(dir);
      }
    }
  }

  // Update coverage from codebase index + scouted dirs (production modules only)
  if (s.codebase_index) {
    const scoutedSet = new Set(s.scouted_dirs.map(d => d.replace(/\/$/, '')));
    let scannedSectors = 0;
    let scannedFiles = 0;
    let totalFiles = 0;
    let totalSectors = 0;
    for (const mod of s.codebase_index.modules) {
      if (mod.production === false) continue;
      const fc = mod.production_file_count ?? mod.file_count ?? 0;
      totalFiles += fc;
      totalSectors++;
      if (scoutedSet.has(mod.path) || scoutedSet.has(mod.path + '/')) {
        scannedSectors++;
        scannedFiles += fc;
      }
    }
    s.sectors_scanned = scannedSectors;
    s.sectors_total = totalSectors;
    s.files_scanned = scannedFiles;
    s.files_total = totalFiles;
  }

  // Fallback: if pending_proposals exist and the LLM sent review results
  // through SCOUT_OUTPUT instead of PROPOSALS_REVIEWED, redirect to the
  // PROPOSALS_REVIEWED handler.
  if (s.pending_proposals !== null) {
    // Path 1: structured reviewed_proposals array in payload
    const reviewedArray = Array.isArray(payload['reviewed_proposals']) ? payload['reviewed_proposals'] : undefined;
    if (Array.isArray(reviewedArray) && reviewedArray.length > 0) {
      return handleProposalsReviewed(ctx, payload);
    }
    // Path 2: XML <reviewed-proposals> block in payload text
    const payloadText = toStringOrUndefined(payload['text']);
    if (typeof payloadText === 'string' && payloadText.includes('<reviewed-proposals>')) {
      const parsed = parseReviewedProposals(payloadText);
      if (parsed && parsed.length > 0) {
        return handleProposalsReviewed(ctx, { reviewed_proposals: parsed });
      }
    }
  }

  // Extract proposals from payload
  const rawProposals = Array.isArray(payload['proposals']) ? payload['proposals'].filter(isRawProposal) : [];

  // Build exploration log entry (before empty-check so retries also get logged)
  const explorationSummary = toStringOrUndefined(payload['exploration_summary']) ?? '';
  const logEntry = explorationSummary
    ? `Attempt ${s.scout_retries + 1}: Explored ${exploredDirs.join(', ') || '(unknown)'}. Found ${rawProposals.length} proposals. ${explorationSummary}`
    : `Attempt ${s.scout_retries + 1}: Explored ${exploredDirs.join(', ') || '(unknown)'}. Found ${rawProposals.length} proposals.`;
  s.scout_exploration_log.push(logEntry);

  if (rawProposals.length === 0) {
    // At high coverage, reduce retry attempts — there's little left to find
    const coveragePct = s.files_total > 0 ? s.files_scanned / s.files_total : 0;
    const effectiveMaxRetries = coveragePct >= 0.9 ? 1 : MAX_SCOUT_RETRIES;

    if (s.scout_retries < effectiveMaxRetries) {
      s.scout_retries++;
      // Stay in SCOUT phase — advance() will return an escalated prompt
      return {
        processed: true,
        phase_changed: false,
        message: `No proposals found (attempt ${s.scout_retries}/${effectiveMaxRetries + 1}). Retrying with deeper analysis.`,
      };
    }

    // Retries exhausted — track consecutive barren cycles
    s.consecutive_barren_cycles = (s.consecutive_barren_cycles ?? 0) + 1;
    const attempts = s.scout_retries + 1;

    // Early termination: stop burning tokens when codebase is exhausted
    if (s.consecutive_barren_cycles >= MAX_BARREN_CYCLES) {
      ctx.run.setPhase('DONE');
      return {
        processed: true,
        phase_changed: true,
        new_phase: 'DONE',
        message: `No proposals after ${s.consecutive_barren_cycles} consecutive barren cycles (${attempts} attempts each). Codebase appears exhausted.`,
      };
    }

    // Try next cycle if budget allows
    if (s.scout_cycles < s.max_cycles) {
      s.scout_retries = 0;
      s.scout_exploration_log = [];
      // Stay in SCOUT — advance() will pick a new sector for the next cycle
      return {
        processed: true,
        phase_changed: false,
        message: `No proposals after ${attempts} attempt(s). Moving to next cycle (${s.consecutive_barren_cycles}/${MAX_BARREN_CYCLES} barren).`,
      };
    }

    // No cycles remaining — genuinely done
    ctx.run.setPhase('DONE');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'DONE',
      message: 'No proposals in scout output after all retries, transitioning to DONE',
    };
  }

  // Store proposals as pending for adversarial review (instead of creating tickets immediately)
  s.pending_proposals = rawProposals;

  // Save proposals artifact
  ctx.run.saveArtifact(
    `${s.step_count}-scout-proposals.json`,
    JSON.stringify({ raw: rawProposals, pending_review: true }, null, 2),
  );

  return {
    processed: true,
    phase_changed: false,
    message: `${rawProposals.length} proposals pending adversarial review`,
  };
}

export async function handleProposalsReviewed(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'SCOUT') {
    return { processed: true, phase_changed: false, message: 'PROPOSALS_REVIEWED outside SCOUT phase, ignored' };
  }

  const pendingProposals = s.pending_proposals;
  if (!pendingProposals || pendingProposals.length === 0) {
    return { processed: true, phase_changed: false, message: 'No pending proposals to review' };
  }

  // Apply revised scores from review
  const reviewedItems: Array<{
    title?: string;
    confidence?: number;
    impact_score?: number;
    review_note?: string;
  }> = [];
  const rawReviewedItems = Array.isArray(payload['reviewed_proposals']) ? payload['reviewed_proposals'] : [];
  for (const item of rawReviewedItems) {
    if (!isRecord(item)) continue;
    reviewedItems.push({
      title: toStringOrUndefined(item['title']),
      confidence: toNumberOrUndefined(item['confidence']),
      impact_score: toNumberOrUndefined(item['impact_score']),
      review_note: toStringOrUndefined(item['review_note']),
    });
  }

  // Merge reviewed scores back into pending proposals
  for (const reviewed of reviewedItems) {
    if (!reviewed.title) continue;
    const reviewedLower = reviewed.title.toLowerCase();
    const match = pendingProposals.find(p => p.title?.toLowerCase() === reviewedLower);
    if (match) {
      // Record learning if confidence lowered >20 pts
      if (s.learnings_enabled && typeof reviewed.confidence === 'number' && typeof match.confidence === 'number') {
        const drop = match.confidence - reviewed.confidence;
        if (drop > 20) {
          addLearning(ctx.run.rootPath, {
            text: `Proposal "${reviewed.title}" had inflated confidence (${match.confidence}→${reviewed.confidence})`,
            category: 'warning',
            source: { type: 'review_downgrade', detail: reviewed.review_note },
            tags: extractTags(match.files ?? match.allowed_paths ?? [], []),
            structured: {
              root_cause: reviewed.review_note ?? `Confidence inflated by ${drop} points`,
              applies_to: match.allowed_paths?.[0],
            },
          });
        }
      }
      if (typeof reviewed.confidence === 'number') match.confidence = reviewed.confidence;
      if (typeof reviewed.impact_score === 'number') match.impact_score = reviewed.impact_score;
    }
  }

  // Clear pending
  s.pending_proposals = null;

  // Now filter and create tickets with revised scores
  const result = await filterAndCreateTickets(ctx.run, ctx.db, pendingProposals);

  // Update exploration log with rejection info
  const lastIdx = s.scout_exploration_log.length - 1;
  if (lastIdx >= 0) {
    s.scout_exploration_log[lastIdx] += ` ${result.accepted.length} accepted, ${result.rejected.length} rejected (${result.rejected.map(r => r.reason).slice(0, 3).join('; ')}).`;
  }

  // Save reviewed artifact
  ctx.run.saveArtifact(
    `${s.step_count}-scout-proposals-reviewed.json`,
    JSON.stringify({ reviewed: reviewedItems, result }, null, 2),
  );

  if (result.created_ticket_ids.length > 0) {
    s.scout_retries = 0;
    s.consecutive_barren_cycles = 0;
    ctx.run.setPhase('NEXT_TICKET');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'NEXT_TICKET',
      message: `Created ${result.created_ticket_ids.length} tickets after review (${result.rejected.length} rejected)`,
    };
  }

  // All proposals rejected after review — reduce retries at high coverage
  const coveragePct = s.files_total > 0 ? s.files_scanned / s.files_total : 0;
  const effectiveMaxRetries = coveragePct >= 0.9 ? 1 : MAX_SCOUT_RETRIES;

  if (s.scout_retries < effectiveMaxRetries) {
    s.scout_retries++;
    return {
      processed: true,
      phase_changed: false,
      message: `All proposals rejected after review (attempt ${s.scout_retries}/${effectiveMaxRetries + 1}). Retrying.`,
    };
  }
  ctx.run.setPhase('DONE');
  return {
    processed: true,
    phase_changed: true,
    new_phase: 'DONE',
    message: `All proposals rejected after review and all retries: ${result.rejected.map(r => r.reason).join('; ')}`,
  };
}

export async function handleProposalsFiltered(ctx: EventContext, _payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  // Emitted after proposal filtering.
  // Check if we have ready tickets now.
  const readyCount = await repos.tickets.countByStatus(ctx.db, s.project_id);
  const ready = isRecord(readyCount) && typeof readyCount['ready'] === 'number' ? readyCount['ready'] : 0;
  if (ready > 0 && s.phase === 'SCOUT') {
    ctx.run.setPhase('NEXT_TICKET');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'NEXT_TICKET',
      message: `${ready} tickets ready, transitioning to NEXT_TICKET`,
    };
  }
  if (ready === 0 && s.phase === 'SCOUT') {
    ctx.run.setPhase('DONE');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'DONE',
      message: 'No proposals accepted, transitioning to DONE',
    };
  }
  return { processed: true, phase_changed: false, message: 'Proposals filtered' };
}
