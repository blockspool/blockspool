/**
 * BlockSpool v2 types — Run state, events, phases, and response contracts.
 *
 * These match the schemas defined in docs/PLUGIN_ROADMAP.md.
 */

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export type Phase =
  | 'SCOUT'
  | 'PLAN'
  | 'EXECUTE'
  | 'QA'
  | 'PR'
  | 'NEXT_TICKET'
  // terminal
  | 'DONE'
  | 'BLOCKED_NEEDS_HUMAN'
  | 'FAILED_BUDGET'
  | 'FAILED_VALIDATION'
  | 'FAILED_SPINDLE';

export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set([
  'DONE',
  'BLOCKED_NEEDS_HUMAN',
  'FAILED_BUDGET',
  'FAILED_VALIDATION',
  'FAILED_SPINDLE',
]);

// ---------------------------------------------------------------------------
// Commit Plan
// ---------------------------------------------------------------------------

export interface CommitPlan {
  ticket_id: string;
  files_to_touch: Array<{
    path: string;
    reason: string;
    action: 'create' | 'modify' | 'delete';
  }>;
  expected_tests: string[];
  risk_level: 'low' | 'medium' | 'high';
  estimated_lines: number;
}

// ---------------------------------------------------------------------------
// Spindle State
// ---------------------------------------------------------------------------

export interface SpindleState {
  output_hashes: string[];
  diff_hashes: string[];
  iterations_since_change: number;
  total_output_chars: number;
  total_change_chars: number;
  failing_command_signatures: string[];
  plan_hashes: string[];
  file_edit_counts?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Run State (persisted to state.json)
// ---------------------------------------------------------------------------

export interface RunState {
  // Identity
  run_id: string;
  session_id: string;
  project_id: string;

  // Phase state machine
  phase: Phase;
  phase_entry_step: number;

  // Budgets
  step_count: number;
  step_budget: number;
  ticket_step_count: number;
  ticket_step_budget: number;
  total_lines_changed: number;
  max_lines_per_ticket: number;
  total_tool_calls: number;
  max_tool_calls_per_ticket: number;

  // Counters
  tickets_completed: number;
  tickets_failed: number;
  tickets_blocked: number;
  prs_created: number;
  scout_cycles: number;
  max_cycles: number;
  max_prs: number;

  // Current work
  current_ticket_id: string | null;
  current_ticket_plan: CommitPlan | null;
  plan_approved: boolean;
  plan_rejections: number;
  qa_retries: number;

  // Time
  started_at: string;
  expires_at: string | null;

  // Config
  scope: string;
  formula: string | null;
  categories: string[];
  min_confidence: number;
  max_proposals_per_scout: number;
  draft_prs: boolean;
  hints: string[];

  // Spindle
  spindle: SpindleState;

  // Intent tracking
  recent_intent_hashes: string[];
}

// ---------------------------------------------------------------------------
// Events (appended to events.ndjson)
// ---------------------------------------------------------------------------

export type EventType =
  | 'SESSION_START'
  | 'ADVANCE_CALLED'
  | 'ADVANCE_RETURNED'
  | 'SCOUT_OUTPUT'
  | 'PROPOSALS_FILTERED'
  | 'TICKETS_CREATED'
  | 'TICKET_ASSIGNED'
  | 'PLAN_SUBMITTED'
  | 'PLAN_APPROVED'
  | 'PLAN_REJECTED'
  | 'TOOL_CALL_ATTEMPTED'
  | 'SCOPE_ALLOWED'
  | 'SCOPE_BLOCKED'
  | 'TICKET_RESULT'
  | 'QA_STARTED'
  | 'QA_COMMAND_RESULT'
  | 'QA_PASSED'
  | 'QA_FAILED'
  | 'PR_CREATED'
  | 'TICKET_COMPLETED'
  | 'TICKET_FAILED'
  | 'BUDGET_WARNING'
  | 'BUDGET_EXHAUSTED'
  | 'SPINDLE_WARNING'
  | 'SPINDLE_ABORT'
  | 'HINT_CONSUMED'
  | 'USER_OVERRIDE'
  | 'SESSION_END';

export interface RunEvent {
  ts: string;
  step: number;
  type: EventType;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Advance Response
// ---------------------------------------------------------------------------

export interface AdvanceConstraints {
  allowed_paths: string[];
  denied_paths: string[];
  denied_patterns: string[];
  max_files: number;
  max_lines: number;
  required_commands: string[];
  plan_required: boolean;
}

export interface AdvanceDigest {
  step: number;
  phase: string;
  tickets_completed: number;
  tickets_failed: number;
  budget_remaining: number;
  ticket_budget_remaining: number;
  spindle_risk: 'none' | 'low' | 'medium' | 'high';
  time_remaining_ms: number | null;
}

export interface AdvanceResponse {
  next_action: 'PROMPT' | 'STOP';
  phase: Phase;
  prompt: string | null;
  reason: string;
  constraints: AdvanceConstraints;
  digest: AdvanceDigest;
}

// ---------------------------------------------------------------------------
// Session Config (user-provided at start)
// ---------------------------------------------------------------------------

export interface SessionConfig {
  hours?: number;
  formula?: string;
  deep?: boolean;
  continuous?: boolean;
  scope?: string;
  categories?: string[];
  min_confidence?: number;
  max_proposals?: number;
  step_budget?: number;
  ticket_step_budget?: number;
  max_prs?: number;
  max_cycles?: number;
  draft_prs?: boolean;
}
