import { repos } from '@promptwheel/core';
import type { EventContext, ProcessResult } from './event-helpers.js';
import {
  classifyQaError,
  EVENT_MAX_ARTIFACT_BYTES,
  maxRetriesForClass,
  extractErrorSignature,
  recordTicketDedup,
  stringifyBoundedArtifactJson,
  toBooleanOrUndefined,
  toNumberOrUndefined,
  toStringArrayOrUndefined,
  toStringOrUndefined,
  truncateArtifactText,
} from './event-helpers.js';
import { recordCommandFailure, recordDiff } from './spindle.js';
import { recordQualitySignal } from './run-state-bridge.js';
import { recordQaCommandResult } from './qa-stats.js';
import { addLearning, confirmLearnings, extractTags, type StructuredKnowledge } from './learnings.js';

export async function handleQaCommandResult(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'QA') {
    return { processed: true, phase_changed: false, message: 'QA command result outside QA phase' };
  }

  const command = toStringOrUndefined(payload['command']) ?? '';
  const success = toBooleanOrUndefined(payload['success']) ?? false;
  const output = toStringOrUndefined(payload['output']) ?? '';
  const durationMs = toNumberOrUndefined(payload['durationMs']) ?? 0;
  const timedOut = toBooleanOrUndefined(payload['timedOut']) ?? false;

  // Record command failure in spindle state
  if (!success) {
    recordCommandFailure(s.spindle, command, output);
  }

  // Record QA command stats for spin tracking
  recordQaCommandResult(ctx.run.rootPath, command, {
    passed: success,
    durationMs,
    timedOut,
    skippedPreExisting: false,
  });

  // Save command output as artifact
  const cmdSlug = command.replace(/[^a-z0-9]/gi, '-').slice(0, 30);
  const artifactRaw = `$ ${command}\n\n${output}`;
  const artifactMetaSuffix = (() => {
    const bytes = Buffer.byteLength(artifactRaw, 'utf8');
    if (bytes <= EVENT_MAX_ARTIFACT_BYTES) return '';
    return `\n\n[output truncated: original_bytes=${bytes}, max_bytes=${EVENT_MAX_ARTIFACT_BYTES}]`;
  })();
  const truncatedArtifact = truncateArtifactText(
    artifactRaw,
    Math.max(0, EVENT_MAX_ARTIFACT_BYTES - Buffer.byteLength(artifactMetaSuffix, 'utf8')),
  );
  ctx.run.saveArtifact(
    `${s.step_count}-qa-${cmdSlug}-${success ? 'pass' : 'fail'}.log`,
    `${truncatedArtifact.text}${artifactMetaSuffix}`,
  );

  return {
    processed: true,
    phase_changed: false,
    message: `QA command ${success ? 'passed' : 'failed'}: ${command}`,
  };
}

export async function handleQaPassed(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'QA') {
    return { processed: true, phase_changed: false, message: 'QA passed outside QA phase' };
  }

  // Confirm injected learnings on success (batch to reduce lock contention)
  if (s.learnings_enabled && s.injected_learning_ids.length > 0) {
    confirmLearnings(ctx.run.rootPath, s.injected_learning_ids);
    s.injected_learning_ids = [];
  }

  // Record quality signal for spin tracking
  recordQualitySignal(ctx.run.rootPath, 'qa_pass');

  // Fetch ticket once — shared by learning recording and dedup below
  const ticket = s.current_ticket_id
    ? await repos.tickets.getById(ctx.db, s.current_ticket_id)
    : null;

  // Record success learning with cochange data from the plan
  if (s.learnings_enabled && ticket) {
    try {
      // Extract cochange files from the approved plan (files that changed together)
      const planFiles = s.current_ticket_plan?.files_to_touch?.map(f => f.path) ?? [];
      const structured: StructuredKnowledge | undefined = planFiles.length > 1
        ? { cochange_files: planFiles, pattern_type: 'dependency' }
        : undefined;
      addLearning(ctx.run.rootPath, {
        text: `${ticket.category ?? 'refactor'} succeeded: ${ticket.title}`.slice(0, 200),
        category: 'pattern',
        source: { type: 'ticket_success', detail: ticket.category ?? 'refactor' },
        tags: extractTags(ticket.allowedPaths ?? [], ticket.verificationCommands ?? []),
        structured,
      });
    } catch (err) {
      console.warn(`[promptwheel] record success learning: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Mark ticket done in DB
  if (s.current_ticket_id) {
    await repos.tickets.updateStatus(ctx.db, s.current_ticket_id, 'done');
  }

  // Build structured ticket summary
  const planFiles = s.current_ticket_plan?.files_to_touch?.map(f => f.path) ?? [];
  s.last_ticket_summary = {
    ticket_id: s.current_ticket_id ?? '',
    title: ticket?.title ?? '',
    changed_files: planFiles,
    lines_changed: s.total_lines_changed,
    tests_run: ticket?.verificationCommands ?? [],
    tests_passed: true,
    risks: s.current_ticket_plan?.risk_level === 'high' ? ['high-risk plan'] : [],
    duration_ms: Date.now() - new Date(s.started_at).getTime(),
    cost_usd: s.total_cost_usd > 0 ? s.total_cost_usd : undefined,
  };

  // Save QA summary artifact
  ctx.run.saveArtifact(
    `${s.step_count}-qa-summary.json`,
    stringifyBoundedArtifactJson(
      {
        ticket_id: s.current_ticket_id,
        status: 'passed',
        attempt: s.qa_retries + 1,
        ...payload,
      },
      {
        ticket_id: s.current_ticket_id,
        status: 'passed',
        attempt: s.qa_retries + 1,
      },
    ),
  );

  // Skip PR phase when not creating PRs
  if (!s.create_prs) {
    await recordTicketDedup(ctx.db, ctx.run.rootPath, s.current_ticket_id, true, undefined, ticket);
    ctx.run.completeTicket();
    ctx.run.appendEvent('TICKET_COMPLETED_NO_PR', payload);
    ctx.run.setPhase('NEXT_TICKET');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'NEXT_TICKET',
      message: 'QA passed, PRs disabled — moving to NEXT_TICKET',
    };
  }

  // Move to PR
  ctx.run.setPhase('PR');
  return {
    processed: true,
    phase_changed: true,
    new_phase: 'PR',
    message: 'QA passed, moving to PR',
  };
}

export async function handleQaFailed(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'QA') {
    return { processed: true, phase_changed: false, message: 'QA failed outside QA phase' };
  }

  // Record quality signal for spin tracking
  recordQualitySignal(ctx.run.rootPath, 'qa_fail');

  // Record QA failure in spindle (for stall detection — no progress)
  recordDiff(s.spindle, null);

  // Save failure artifact
  ctx.run.saveArtifact(
    `${s.step_count}-qa-failed-attempt-${s.qa_retries + 1}.json`,
    stringifyBoundedArtifactJson(
      {
        ticket_id: s.current_ticket_id,
        attempt: s.qa_retries + 1,
        ...payload,
      },
      {
        ticket_id: s.current_ticket_id,
        attempt: s.qa_retries + 1,
      },
    ),
  );

  s.qa_retries++;

  // Store failure context for critic block injection on retry
  const failedCommands = (() => {
    const explicitFailed = payload['failed_commands'];
    if (typeof explicitFailed === 'string') return [explicitFailed];
    const explicitFailedArray = toStringArrayOrUndefined(explicitFailed);
    if (explicitFailedArray) return explicitFailedArray;
    const singleCommand = toStringOrUndefined(payload['command']);
    return singleCommand ? [singleCommand] : [];
  })();
  const errorOutput = toStringOrUndefined(payload['error']) ?? toStringOrUndefined(payload['output']) ?? '';
  s.last_qa_failure = {
    failed_commands: failedCommands,
    error_output: errorOutput.slice(0, 500),
  };

  // Classify error to determine retry strategy
  const errorClass = classifyQaError(errorOutput);
  const maxRetries = maxRetriesForClass(errorClass);

  if (s.qa_retries >= maxRetries) {
    // Fetch ticket once for both learning and dedup
    const ticket = s.current_ticket_id ? await repos.tickets.getById(ctx.db, s.current_ticket_id) : null;
    // Record learning on final QA failure
    if (s.learnings_enabled) {
      const primaryFailedCommand = failedCommands[0] ?? '';
      const errorSummary = errorOutput.slice(0, 100);
      const errorSig = extractErrorSignature(errorOutput);
      const structured: StructuredKnowledge = {
        pattern_type: errorClass === 'environment' ? 'environment' : 'antipattern',
        failure_context: {
          command: primaryFailedCommand || (ticket?.verificationCommands?.[0] ?? ''),
          error_signature: errorSig ?? errorSummary.slice(0, 120),
        },
        fragile_paths: ticket?.allowedPaths?.filter(p => !p.includes('*')),
      };
      addLearning(ctx.run.rootPath, {
        text: `QA fails on ${ticket?.title ?? 'unknown'} — ${errorSummary || primaryFailedCommand}`.slice(0, 200),
        category: 'gotcha',
        source: { type: 'qa_failure', detail: primaryFailedCommand },
        tags: extractTags(ticket?.allowedPaths ?? [], ticket?.verificationCommands ?? []),
        structured,
      });
    }
    // Record failed ticket in dedup memory + sector failure
    await recordTicketDedup(ctx.db, ctx.run.rootPath, s.current_ticket_id, false, 'qa_failed', ticket);
    // Give up on this ticket
    if (s.current_ticket_id) {
      await repos.tickets.updateStatus(ctx.db, s.current_ticket_id, 'blocked');
      ctx.run.failTicket(`QA failed ${s.qa_retries} times (${errorClass})`);
    }
    ctx.run.setPhase('NEXT_TICKET');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'NEXT_TICKET',
      message: errorClass === 'environment'
        ? `QA failed (${errorClass} error — not retryable), giving up on ticket`
        : `QA failed ${s.qa_retries}/${maxRetries} times (${errorClass}), giving up on ticket`,
    };
  }

  // Retry: go back to EXECUTE to fix
  ctx.run.setPhase('EXECUTE');
  return {
    processed: true,
    phase_changed: true,
    new_phase: 'EXECUTE',
    message: `QA failed (attempt ${s.qa_retries}/${maxRetries}, ${errorClass}), retrying execution`,
  };
}
