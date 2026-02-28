import { repos } from '@promptwheel/core';
import type { EventContext, ProcessResult } from './event-helpers.js';
import {
  recordSectorOutcome,
  recordTicketDedup,
  isRecord,
  toNumberOrUndefined,
  toStringArrayOrUndefined,
  toStringOrUndefined,
  stringifyBoundedArtifactJson,
} from './event-helpers.js';
import type { CommitPlan } from './types.js';
import { deriveScopePolicy, validatePlanScope } from './scope-policy.js';
import { recordDiff, recordPlanHash } from './spindle.js';
import { addLearning, extractTags, type StructuredKnowledge } from './learnings.js';
import { isStreamJsonOutput, analyzeTrace } from '@promptwheel/core/trace/shared';

export interface TicketResultValidationInput {
  payload: Record<string, unknown>;
  currentPlan: CommitPlan | null;
  maxLinesPerTicket: number;
}

export interface TicketResultValidationResult {
  status: string;
  changedFiles: string[];
  linesAdded: number;
  linesRemoved: number;
  totalLines: number;
  isCompletion: boolean;
  isFailure: boolean;
  rejectionKind: 'scope' | 'line_budget' | null;
  rejectionMessage: string | null;
  surpriseFiles: string[];
  plannedFiles: string[];
}

/**
 * Note: changed_files comes from agent self-report. The MCP server doesn't have
 * direct worktree access to run `git diff --name-only` for verification. The CLI
 * path (solo-auto-execute) does have verified changed files from step-scope.ts.
 * The plan cross-check below is the MCP path's best verification layer.
 */
export function validateTicketResultPayload(input: TicketResultValidationInput): TicketResultValidationResult {
  const status = toStringOrUndefined(input.payload['status']) ?? '';
  const changedFiles = toStringArrayOrUndefined(input.payload['changed_files']) ?? [];
  const linesAdded = toNumberOrUndefined(input.payload['lines_added']) ?? 0;
  const linesRemoved = toNumberOrUndefined(input.payload['lines_removed']) ?? 0;
  const totalLines = linesAdded + linesRemoved;
  const isCompletion = status === 'done' || status === 'success';
  const isFailure = status === 'failed';

  let rejectionKind: TicketResultValidationResult['rejectionKind'] = null;
  let rejectionMessage: string | null = null;
  let surpriseFiles: string[] = [];
  let plannedFiles: string[] = [];

  if (isCompletion && input.currentPlan) {
    plannedFiles = input.currentPlan.files_to_touch.map(f => f.path);
    const plannedPaths = new Set(plannedFiles);
    surpriseFiles = changedFiles.filter(f => !plannedPaths.has(f));

    if (surpriseFiles.length > 0) {
      rejectionKind = 'scope';
      rejectionMessage = `Changed files not in plan: ${surpriseFiles.join(', ')}. Revert those changes and re-submit.`;
    } else if (totalLines > input.maxLinesPerTicket) {
      rejectionKind = 'line_budget';
      rejectionMessage = `Lines changed (${totalLines}) exceeds budget (${input.maxLinesPerTicket}). Reduce changes.`;
    }
  }

  return {
    status,
    changedFiles,
    linesAdded,
    linesRemoved,
    totalLines,
    isCompletion,
    isFailure,
    rejectionKind,
    rejectionMessage,
    surpriseFiles,
    plannedFiles,
  };
}

export async function handlePlanSubmitted(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'PLAN') {
    return { processed: true, phase_changed: false, message: 'Plan submitted outside PLAN phase, ignored' };
  }

  const raw = payload;
  // Coerce files_to_touch — accept files/touched_files as fallback names
  const rawFiles = Array.isArray(raw.files_to_touch) ? raw.files_to_touch
    : Array.isArray(raw.files) ? raw.files
    : Array.isArray(raw.touched_files) ? raw.touched_files : [];
  const files_to_touch: CommitPlan['files_to_touch'] = [];
  for (const file of rawFiles) {
    if (typeof file === 'string') {
      files_to_touch.push({ path: file, action: 'modify', reason: '' });
      continue;
    }
    if (isRecord(file)) {
      const pathValue = toStringOrUndefined(file['path']);
      if (!pathValue) continue;
      const actionValue = toStringOrUndefined(file['action']);
      const action: 'create' | 'modify' | 'delete' =
        actionValue === 'create' || actionValue === 'modify' || actionValue === 'delete'
          ? actionValue
          : 'modify';
      files_to_touch.push({
        path: pathValue,
        action,
        reason: toStringOrUndefined(file['reason']) ?? '',
      });
      continue;
    }
    if (file !== undefined && file !== null) {
      files_to_touch.push({ path: String(file), action: 'modify', reason: '' });
    }
  }
  const plan: CommitPlan = {
    ticket_id: toStringOrUndefined(raw.ticket_id) ?? String(raw.ticket_id ?? s.current_ticket_id ?? ''),
    files_to_touch,
    expected_tests: toStringArrayOrUndefined(raw.expected_tests) ?? [],
    risk_level: (raw.risk_level === 'low' || raw.risk_level === 'medium' || raw.risk_level === 'high')
      ? raw.risk_level : 'low',
    estimated_lines: toNumberOrUndefined(raw.estimated_lines) ?? 50,
  };

  // Derive scope policy for the current ticket
  const ticket = s.current_ticket_id
    ? await repos.tickets.getById(ctx.db, s.current_ticket_id)
    : null;

  const policy = deriveScopePolicy({
    allowedPaths: ticket?.allowedPaths ?? [],
    category: ticket?.category ?? 'refactor',
    maxLinesPerTicket: s.max_lines_per_ticket,
    learnings: s.cached_learnings,
  });

  // Validate plan against scope policy
  const scopeResult = validatePlanScope(
    plan.files_to_touch,
    plan.estimated_lines,
    plan.risk_level,
    policy,
  );

  if (!scopeResult.valid) {
    s.plan_rejections++;
    s.last_plan_rejection_reason = scopeResult.reason ?? null;
    ctx.run.appendEvent('PLAN_REJECTED', { reason: scopeResult.reason, attempt: s.plan_rejections });
    // Record learning on plan rejection
    if (s.learnings_enabled) {
      const structured: StructuredKnowledge = {
        root_cause: scopeResult.reason ?? 'scope violation',
        pattern_type: 'convention',
        applies_to: ticket?.allowedPaths?.[0],
      };
      addLearning(ctx.run.rootPath, {
        text: `Plan rejected: ${scopeResult.reason}`.slice(0, 200),
        category: 'gotcha',
        source: { type: 'plan_rejection', detail: scopeResult.reason ?? undefined },
        tags: extractTags(plan.files_to_touch.map(f => f.path), []),
        structured,
      });
    }
    return {
      processed: true,
      phase_changed: false,
      message: `Plan rejected: ${scopeResult.reason} (attempt ${s.plan_rejections}/${3})`,
    };
  }

  // Plan passed validation
  s.current_ticket_plan = plan;
  recordPlanHash(s.spindle, plan);

  // High-risk plans → BLOCKED_NEEDS_HUMAN
  if (plan.risk_level === 'high') {
    ctx.run.appendEvent('PLAN_REJECTED', { reason: 'High-risk plan requires human approval', risk_level: 'high' });
    ctx.run.setPhase('BLOCKED_NEEDS_HUMAN');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'BLOCKED_NEEDS_HUMAN',
      message: 'High-risk plan requires human approval',
    };
  }

  // Low/medium risk — auto-approve
  s.plan_approved = true;
  ctx.run.appendEvent('PLAN_APPROVED', { risk_level: plan.risk_level, auto: true });
  ctx.run.setPhase('EXECUTE');
  return {
    processed: true,
    phase_changed: true,
    new_phase: 'EXECUTE',
    message: `${plan.risk_level}-risk plan auto-approved, moving to EXECUTE`,
  };
}

export async function handleTicketResult(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'EXECUTE') {
    return { processed: true, phase_changed: false, message: 'Ticket result outside EXECUTE phase' };
  }

  const validation = validateTicketResultPayload({
    payload,
    currentPlan: s.current_ticket_plan,
    maxLinesPerTicket: s.max_lines_per_ticket,
  });
  const {
    status,
    changedFiles,
    linesAdded,
    linesRemoved,
    totalLines,
  } = validation;

  // Accept both 'done' and 'success' as completion status
  if (validation.isCompletion) {
    // Save ticket result artifact
    ctx.run.saveArtifact(
      `${s.step_count}-ticket-result.json`,
      stringifyBoundedArtifactJson(
        {
          status,
          changed_files: changedFiles,
          lines_added: linesAdded,
          lines_removed: linesRemoved,
          summary: payload['summary'],
        },
        {
          status,
          changed_files_count: changedFiles.length,
          lines_added: linesAdded,
          lines_removed: linesRemoved,
        },
      ),
    );

    if (validation.rejectionKind === 'scope') {
      ctx.run.appendEvent('SCOPE_BLOCKED', {
        ticket_id: s.current_ticket_id,
        surprise_files: validation.surpriseFiles,
        planned_files: validation.plannedFiles,
      });
    }
    if (validation.rejectionMessage) {
      return {
        processed: true,
        phase_changed: false,
        message: validation.rejectionMessage,
      };
    }

    // Track lines
    s.total_lines_changed += totalLines;

    // Update spindle state with diff info
    const diff = toStringOrUndefined(payload['diff']) ?? null;
    recordDiff(s.spindle, diff ?? (changedFiles.length > 0 ? changedFiles.join('\n') : null));

    // Opportunistic trace analysis: if stdout is in payload, check for stream-json
    const stdout = toStringOrUndefined(payload['stdout']);
    if (stdout && isStreamJsonOutput(stdout.split('\n')[0] ?? '')) {
      try {
        const traceAnalysis = analyzeTrace(stdout);
        ctx.run.appendEvent('TRACE_ANALYSIS', {
          ticket_id: s.current_ticket_id,
          is_stream_json: traceAnalysis.is_stream_json,
          compaction_count: traceAnalysis.compactions.length,
          total_tokens: traceAnalysis.total_input_tokens + traceAnalysis.total_output_tokens,
          tool_count: traceAnalysis.tool_profiles.length,
        });
      } catch (err) {
        console.warn(`[promptwheel] trace analysis: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Move to QA
    ctx.run.setPhase('QA');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'QA',
      message: `Ticket result accepted (${changedFiles.length} files, ${totalLines} lines), moving to QA`,
    };
  }

  if (validation.isFailure) {
    // Fetch ticket once for both learning and dedup
    const ticket = s.current_ticket_id ? await repos.tickets.getById(ctx.db, s.current_ticket_id) : null;
    // Record learning on ticket failure
    if (s.learnings_enabled) {
      const reason = toStringOrUndefined(payload['reason']) ?? 'Execution failed';
      const structured: StructuredKnowledge = {
        root_cause: reason.slice(0, 200),
        fragile_paths: ticket?.allowedPaths?.filter(p => !p.includes('*')),
      };
      addLearning(ctx.run.rootPath, {
        text: `Ticket failed on ${ticket?.title ?? 'unknown'} — ${reason}`.slice(0, 200),
        category: 'warning',
        source: { type: 'ticket_failure', detail: reason },
        tags: extractTags(ticket?.allowedPaths ?? [], ticket?.verificationCommands ?? []),
        structured,
      });
    }
    // Record failed ticket in dedup memory + sector failure
    await recordTicketDedup(ctx.db, ctx.run.rootPath, s.current_ticket_id, false, 'agent_error', ticket);
    recordSectorOutcome(ctx.run.rootPath, s.current_sector_path, 'failure');
    // Fail the ticket, move to next
    if (s.current_ticket_id) {
      await repos.tickets.updateStatus(ctx.db, s.current_ticket_id, 'blocked');
      ctx.run.failTicket(toStringOrUndefined(payload['reason']) ?? 'Execution failed');
    }
    ctx.run.setPhase('NEXT_TICKET');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'NEXT_TICKET',
      message: 'Ticket failed, moving to NEXT_TICKET',
    };
  }

  return { processed: true, phase_changed: false, message: `Ticket result: ${status}` };
}

export async function handlePrCreated(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'PR') {
    return { processed: true, phase_changed: false, message: 'PR created outside PR phase' };
  }

  // Record completed ticket in dedup memory + sector success (before completeTicket clears current_ticket_id)
  await recordTicketDedup(ctx.db, ctx.run.rootPath, s.current_ticket_id, true);
  recordSectorOutcome(ctx.run.rootPath, s.current_sector_path, 'success');

  // Save PR artifact
  ctx.run.saveArtifact(
    `${s.step_count}-pr-created.json`,
    JSON.stringify({
      ticket_id: s.current_ticket_id,
      pr_number: s.prs_created + 1,
      ...payload,
    }, null, 2),
  );

  s.prs_created++;
  ctx.run.completeTicket();
  ctx.run.appendEvent('PR_CREATED', payload);
  ctx.run.setPhase('NEXT_TICKET');
  return {
    processed: true,
    phase_changed: true,
    new_phase: 'NEXT_TICKET',
    message: `PR created (${s.prs_created}/${s.max_prs}), moving to NEXT_TICKET`,
  };
}
