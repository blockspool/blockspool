/**
 * Pure trajectory algorithms — no filesystem.
 *
 * Shared by both @promptwheel/cli and @promptwheel/mcp.
 * Callers handle file I/O (reading YAML files from .promptwheel/trajectories/).
 *
 * A trajectory is a DAG of ordered steps that the wheel follows across cycles.
 * Each step constrains the scout's scope, categories, and acceptance criteria.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrajectoryStep {
  id: string;
  title: string;
  description: string;
  scope?: string;                // overrides session scope for this step
  categories?: string[];          // overrides formula categories
  acceptance_criteria: string[];
  verification_commands: string[];
  depends_on: string[];           // step IDs that must complete first
  max_retries?: number;            // override default retry limit for this step
  priority?: number;               // 1-10, higher = more important (default 5)
  measure?: {
    cmd: string;
    target: number;
    direction: 'up' | 'down';
  };
}

export interface Trajectory {
  name: string;
  description: string;
  steps: TrajectoryStep[];
}

export type StepStatus = 'pending' | 'active' | 'completed' | 'failed' | 'skipped';

export interface StepState {
  stepId: string;
  status: StepStatus;
  cyclesAttempted: number;
  lastAttemptedCycle: number;
  completedAt?: number;
  failureReason?: string;
  measurement?: { value: number | null; timestamp: number };
  /** Last verification command output — helps LLM understand what failed */
  lastVerificationOutput?: string;
  /** Count of consecutive verification failures — resets on any pass */
  consecutiveFailures?: number;
  /** Total verification failures (never resets) — detects flaky tests */
  totalFailures?: number;
  /** Per-command verification outcomes — enables flakiness detection */
  commandOutcomes?: Array<{
    command: string;
    passed: boolean;
    failCount: number;
    lastOutput?: string;
  }>;
}

export type TrajectoryStatus = 'active' | 'completed' | 'abandoned';

export interface TrajectoryState {
  trajectoryName: string;
  startedAt: number;
  stepStates: Record<string, StepState>;
  currentStepId: string | null;
  paused: boolean;
  status?: TrajectoryStatus;
}

// ---------------------------------------------------------------------------
// Pure algorithms
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;

/** Can this step start? All dependencies must be resolved (completed, skipped, or failed). */
export function stepReady(step: TrajectoryStep, states: Record<string, StepState>): boolean {
  for (const depId of step.depends_on) {
    const dep = states[depId];
    if (!dep || (dep.status !== 'completed' && dep.status !== 'skipped' && dep.status !== 'failed')) return false;
  }
  return true;
}

/**
 * Pick next step: highest-priority ready step among pending/active steps.
 * When priorities are equal, falls back to declaration order.
 */
export function getNextStep(trajectory: Trajectory, states: Record<string, StepState>): TrajectoryStep | null {
  let best: TrajectoryStep | null = null;
  let bestPriority = -1;
  for (const step of trajectory.steps) {
    const state = states[step.id];
    if (!state) continue;
    if (state.status === 'completed' || state.status === 'skipped' || state.status === 'failed') continue;
    if (!stepReady(step, states)) continue;
    const prio = step.priority ?? 5;
    if (prio > bestPriority) {
      best = step;
      bestPriority = prio;
    }
  }
  return best;
}

/**
 * Get all steps that are ready to execute (dependencies resolved, not in terminal state).
 * Returns steps sorted by priority (highest first). Enables parallel execution of
 * independent steps within the same trajectory.
 */
export function getReadySteps(trajectory: Trajectory, states: Record<string, StepState>): TrajectoryStep[] {
  const ready: TrajectoryStep[] = [];
  for (const step of trajectory.steps) {
    const state = states[step.id];
    if (!state) continue;
    if (state.status === 'completed' || state.status === 'skipped' || state.status === 'failed') continue;
    if (!stepReady(step, states)) continue;
    ready.push(step);
  }
  // Sort by priority descending (highest first)
  return ready.sort((a, b) => (b.priority ?? 5) - (a.priority ?? 5));
}

/** All steps in a terminal state (completed, skipped, or failed)? */
export function trajectoryComplete(trajectory: Trajectory, states: Record<string, StepState>): boolean {
  for (const step of trajectory.steps) {
    const state = states[step.id];
    if (!state) return false;
    if (state.status !== 'completed' && state.status !== 'skipped' && state.status !== 'failed') return false;
  }
  return true;
}

/** All non-failed steps completed or skipped? (i.e., every step that could succeed has.) */
export function trajectoryFullySucceeded(trajectory: Trajectory, states: Record<string, StepState>): boolean {
  for (const step of trajectory.steps) {
    const state = states[step.id];
    if (!state) return false;
    if (state.status !== 'completed' && state.status !== 'skipped') return false;
  }
  return true;
}

/**
 * Check if any active step has exceeded its retry limit or is flaky.
 * Uses per-step max_retries when steps are provided, otherwise falls back to the global default.
 * Flaky detection: if totalFailures > 2 * max_retries, the step alternates pass/fail and should be failed.
 * Returns stuck step ID or null.
 */
export function trajectoryStuck(
  states: Record<string, StepState>,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  steps?: TrajectoryStep[],
): string | null {
  const stepMap = steps ? new Map(steps.map(s => [s.id, s])) : null;
  for (const [stepId, state] of Object.entries(states)) {
    if (state.status === 'active') {
      const limit = stepMap?.get(stepId)?.max_retries ?? maxRetries;
      // Standard stuck: consecutive attempts exhausted
      if (state.cyclesAttempted >= limit) {
        return stepId;
      }
      // Flaky detection: total failures way exceeds limit even though consecutive resets
      if (state.totalFailures && state.totalFailures >= limit * 2) {
        return stepId;
      }
    }
  }
  return null;
}

/** Format trajectory context for scout prompt injection. */
export function formatTrajectoryForPrompt(
  trajectory: Trajectory,
  states: Record<string, StepState>,
  currentStep: TrajectoryStep,
): string {
  const lines: string[] = [
    '<trajectory>',
    `## Trajectory: ${trajectory.name}`,
    trajectory.description,
    '',
  ];

  // Completed steps
  const completed = trajectory.steps.filter(s => states[s.id]?.status === 'completed');
  if (completed.length > 0) {
    lines.push('### Completed Steps');
    for (const step of completed) {
      lines.push(`- [x] ${step.title}`);
    }
    lines.push('');
  }

  // Current step (the focus)
  lines.push('### Current Step (FOCUS HERE)');
  lines.push(`**${currentStep.title}**`);
  lines.push(currentStep.description);
  lines.push('');
  if (currentStep.acceptance_criteria.length > 0) {
    lines.push('**Acceptance Criteria:**');
    for (const ac of currentStep.acceptance_criteria) {
      lines.push(`- ${ac}`);
    }
    lines.push('');
  }
  if (currentStep.scope) {
    lines.push(`**Scope:** \`${currentStep.scope}\``);
  }
  if (currentStep.categories && currentStep.categories.length > 0) {
    lines.push(`**Categories:** ${currentStep.categories.join(', ')}`);
  }
  if (currentStep.measure) {
    const arrow = currentStep.measure.direction === 'up' ? '>' : '<';
    lines.push(`**Measure:** target ${arrow}= ${currentStep.measure.target}`);
  }

  const stepState = states[currentStep.id];
  if (stepState && stepState.cyclesAttempted > 0) {
    const limit = currentStep.max_retries ?? DEFAULT_MAX_RETRIES;
    lines.push(`**Attempts:** ${stepState.cyclesAttempted}/${limit} cycle(s)`);
    if (stepState.lastVerificationOutput) {
      lines.push('');
      lines.push('**Last verification output (fix this):**');
      lines.push('```');
      lines.push(stepState.lastVerificationOutput);
      lines.push('```');
    }
    if (stepState.consecutiveFailures && stepState.consecutiveFailures >= 2) {
      lines.push(`**Warning:** This step has failed ${stepState.consecutiveFailures} consecutive times. Try a different approach.`);
    }
    const flaky = stepState.commandOutcomes?.filter(c => c.failCount > 0 && c.failCount < (stepState.totalFailures ?? 0));
    if (flaky?.length) {
      lines.push(`**Flaky commands:** ${flaky.map(c => c.command).join(', ')}`);
    }
  }
  lines.push('');

  // Remaining steps
  const remaining = trajectory.steps.filter(s => {
    const st = states[s.id];
    return st && s.id !== currentStep.id && st.status !== 'completed' && st.status !== 'skipped';
  });
  if (remaining.length > 0) {
    lines.push('### Upcoming Steps');
    for (const step of remaining) {
      if (step.id === currentStep.id) continue;
      const deps = step.depends_on.length > 0 ? ` (after: ${step.depends_on.join(', ')})` : '';
      lines.push(`- [ ] ${step.title}${deps}`);
    }
    lines.push('');
  }

  lines.push('Proposals should advance the **current step** toward its acceptance criteria.');
  lines.push('</trajectory>');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Trajectory YAML parsing (pure — no filesystem)
// ---------------------------------------------------------------------------

/**
 * Parse a trajectory YAML document into a Trajectory object.
 * Handles the nested steps array with all fields.
 */
export function parseTrajectoryYaml(content: string): Trajectory {
  const lines = content.split('\n');

  let name = '';
  let description = '';
  const steps: TrajectoryStep[] = [];
  let currentStep: Partial<TrajectoryStep> | null = null;
  let currentListKey: string | null = null;
  let currentList: string[] = [];
  let inMeasure = false;
  let measureObj: { cmd?: string; target?: number; direction?: 'up' | 'down' } = {};

  function flushList() {
    if (currentStep && currentListKey && currentList.length > 0) {
      (currentStep as any)[currentListKey] = [...currentList];
    }
    currentListKey = null;
    currentList = [];
  }

  function flushMeasure() {
    if (currentStep && inMeasure && measureObj.cmd !== undefined && measureObj.target !== undefined && measureObj.direction) {
      currentStep.measure = { cmd: measureObj.cmd, target: measureObj.target, direction: measureObj.direction };
    }
    inMeasure = false;
    measureObj = {};
  }

  function flushStep() {
    flushList();
    flushMeasure();
    if (currentStep) {
      if (currentStep.id) {
        steps.push({
          id: currentStep.id,
          title: currentStep.title ?? '',
          description: currentStep.description ?? '',
          scope: currentStep.scope,
          categories: currentStep.categories,
          acceptance_criteria: currentStep.acceptance_criteria ?? [],
          verification_commands: currentStep.verification_commands ?? [],
          depends_on: currentStep.depends_on ?? [],
          max_retries: currentStep.max_retries,
          priority: currentStep.priority,
          measure: currentStep.measure,
        });
      } else if (currentStep.title) {
        // Step has content but no ID — warn instead of silently dropping
        console.warn(`Warning: trajectory step "${currentStep.title}" dropped — missing id`);
      }
    }
    currentStep = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines at top level
    if (trimmed.startsWith('#') || trimmed === '') {
      // Empty line in a list context ends the list
      if (trimmed === '' && currentListKey) {
        flushList();
      }
      continue;
    }

    // Top-level fields
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      flushStep();
      const match = trimmed.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
      if (match) {
        const [, key, value] = match;
        if (key === 'name') name = stripQuotes(value);
        else if (key === 'description') description = stripQuotes(value);
      }
      continue;
    }

    // Steps array marker
    if (trimmed === '- id:' || trimmed.startsWith('- id:')) {
      flushStep();
      currentStep = {};
      const idMatch = trimmed.match(/^-\s*id\s*:\s*(.*)/);
      if (idMatch) {
        currentStep.id = idMatch[1].trim();
      }
      continue;
    }

    // Inside a step
    if (currentStep) {
      // Check for measure sub-object
      if (inMeasure) {
        const mMatch = trimmed.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
        if (mMatch) {
          const [, mKey, mVal] = mMatch;
          // Check indent — measure fields should be deeper than "measure:"
          const indent = line.length - line.trimStart().length;
          if (indent >= 6) {
            if (mKey === 'cmd') measureObj.cmd = mVal.trim().replace(/^["']|["']$/g, '');
            else if (mKey === 'target') measureObj.target = parseFloat(mVal.trim());
            else if (mKey === 'direction') measureObj.direction = mVal.trim() as 'up' | 'down';
            continue;
          } else {
            // Back to step level
            flushMeasure();
          }
        }
      }

      // List item
      if (trimmed.startsWith('- ')) {
        const item = stripQuotes(trimmed.slice(2));
        if (currentListKey) {
          currentList.push(item);
          continue;
        }
      }

      // Key: value within a step
      const kvMatch = trimmed.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
      if (kvMatch) {
        flushList();
        const [, key, rawVal] = kvMatch;
        const val = rawVal.trim();

        switch (key) {
          case 'title':
            currentStep.title = stripQuotes(val);
            break;
          case 'description':
            currentStep.description = stripQuotes(val);
            break;
          case 'scope':
            currentStep.scope = stripQuotes(val);
            break;
          case 'categories':
            currentStep.categories = parseSimpleList(val);
            break;
          case 'acceptance_criteria':
            currentListKey = 'acceptance_criteria';
            currentList = [];
            break;
          case 'verification_commands':
            currentListKey = 'verification_commands';
            currentList = [];
            break;
          case 'depends_on':
            currentStep.depends_on = parseSimpleList(val);
            break;
          case 'max_retries': {
            const n = parseInt(val, 10);
            if (!isNaN(n) && n > 0) currentStep.max_retries = n;
            break;
          }
          case 'priority': {
            const p = parseInt(val, 10);
            if (!isNaN(p) && p >= 1 && p <= 10) currentStep.priority = p;
            break;
          }
          case 'measure':
            inMeasure = true;
            measureObj = {};
            break;
          default:
            break;
        }
      }
    }
  }

  // Flush final step
  flushStep();

  return { name, description, steps };
}

/** Strip surrounding quotes from a YAML value (double or single). */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

/** Parse "[a, b, c]" or "a, b, c" → string[]. Also handles YAML inline sequences. */
function parseSimpleList(value: string): string[] {
  const stripped = value.replace(/^\[/, '').replace(/\]$/, '');
  return stripped.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/** Detect cycles in step dependency graph. Returns cycle node IDs or null. */
export function detectCycle(steps: TrajectoryStep[]): string[] | null {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const step of steps) {
    inDegree.set(step.id, 0);
    adj.set(step.id, []);
  }
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (adj.has(dep)) {
        adj.get(dep)!.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      }
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let sorted = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }
  if (sorted === steps.length) return null;
  return steps.filter(s => (inDegree.get(s.id) ?? 0) > 0).map(s => s.id);
}

// ---------------------------------------------------------------------------
// Graph-based ordering
// ---------------------------------------------------------------------------

/**
 * Collect all unique module paths from the dependency graph (keys + values).
 */
function allModules(edges: Record<string, string[]>): string[] {
  const set = new Set<string>();
  for (const [source, targets] of Object.entries(edges)) {
    set.add(source);
    for (const t of targets) set.add(t);
  }
  return [...set];
}

/**
 * Resolve a scope glob or file path to the set of modules it matches
 * in the dependency graph. Matches on prefix (directory scope) or exact key.
 */
function resolveToModules(scope: string | undefined, edges: Record<string, string[]>): string[] {
  if (!scope) return [];
  const modules = allModules(edges);
  // Trim trailing glob stars: "packages/cli/**" → "packages/cli/"
  const prefix = scope.replace(/\*+$/, '');
  return modules.filter(m => m === scope || m.startsWith(prefix));
}

/**
 * Post-process a trajectory to enforce dependency graph ordering.
 *
 * For each pair of steps (A, B), if A's scope touches a module that is imported
 * by a module in B's scope, and B doesn't already depend on A, add A as a
 * dependency of B. Skips the edge if it would introduce a cycle.
 *
 * This is a pure function — returns a new Trajectory with updated depends_on.
 */
export function enforceGraphOrdering(
  trajectory: Trajectory,
  edges: Record<string, string[]>,
): Trajectory {
  if (!edges || Object.keys(edges).length === 0) return trajectory;

  // Pre-compute modules for each step
  const stepModules = new Map<string, Set<string>>();
  for (const step of trajectory.steps) {
    stepModules.set(step.id, new Set(resolveToModules(step.scope, edges)));
  }

  // Build reverse edge map: module → set of modules that import it
  const importedBy = new Map<string, Set<string>>();
  for (const [source, targets] of Object.entries(edges)) {
    for (const target of targets) {
      let set = importedBy.get(target);
      if (!set) {
        set = new Set();
        importedBy.set(target, set);
      }
      set.add(source);
    }
  }

  // Clone steps with mutable depends_on
  const newSteps = trajectory.steps.map(s => ({
    ...s,
    depends_on: [...s.depends_on],
  }));

  const stepById = new Map(newSteps.map(s => [s.id, s]));

  // For each pair (A, B), check if A's modules are imported by B's modules
  for (const stepA of newSteps) {
    const modsA = stepModules.get(stepA.id)!;
    if (modsA.size === 0) continue;

    for (const stepB of newSteps) {
      if (stepA.id === stepB.id) continue;
      if (stepB.depends_on.includes(stepA.id)) continue; // already depends

      const modsB = stepModules.get(stepB.id)!;
      if (modsB.size === 0) continue;

      // Check: does any module in B import any module in A?
      let bImportsA = false;
      for (const modA of modsA) {
        const importers = importedBy.get(modA);
        if (!importers) continue;
        for (const modB of modsB) {
          if (importers.has(modB)) {
            bImportsA = true;
            break;
          }
        }
        if (bImportsA) break;
      }

      if (!bImportsA) continue;

      // Tentatively add the edge and check for cycles
      stepB.depends_on.push(stepA.id);
      if (detectCycle(newSteps)) {
        // Would create a cycle — revert
        stepB.depends_on.pop();
      }
    }
  }

  return {
    ...trajectory,
    steps: newSteps,
  };
}

// ---------------------------------------------------------------------------
// Skip / force-complete helpers — shared across CLI + MCP
// ---------------------------------------------------------------------------

export interface SkipStepResult {
  skipped: boolean;
  error?: string;
  nextStep: { id: string; title: string } | null;
}

/**
 * Mark a step as skipped and advance to the next eligible step.
 * Shared logic used by trajectory_skip tool, heal_trajectory skip action,
 * and CLI `solo trajectory skip` command.
 *
 * Returns the result with next step info. Does NOT persist state — caller
 * must call saveTrajectoryState() after.
 */
export function skipStep(
  trajectory: Trajectory,
  state: TrajectoryState,
  stepId: string,
): SkipStepResult {
  const stepState = state.stepStates[stepId];
  if (!stepState) {
    return { skipped: false, error: `Step "${stepId}" not found in trajectory`, nextStep: null };
  }
  if (stepState.status === 'completed' || stepState.status === 'skipped') {
    return { skipped: false, error: `Step "${stepId}" is already ${stepState.status}`, nextStep: null };
  }

  stepState.status = 'skipped';
  stepState.completedAt = Date.now();

  const next = getNextStep(trajectory, state.stepStates);
  if (next) {
    state.stepStates[next.id].status = 'active';
    state.currentStepId = next.id;
  } else {
    state.currentStepId = null;
  }

  return {
    skipped: true,
    nextStep: next ? { id: next.id, title: next.title } : null,
  };
}

// ---------------------------------------------------------------------------
// Pre-verification — auto-advance steps whose commands already pass
// ---------------------------------------------------------------------------

export interface CommandResult { exitCode: number; timedOut: boolean; output: string }
export type CommandExecutor = (cmd: string, cwd: string) => CommandResult;

export interface PreVerifyResult {
  advanced: number;
  completedSteps: Array<{ id: string; title: string }>;
}

/**
 * Loop through trajectory steps, auto-completing any whose verification
 * commands already pass. Shared between CLI and MCP so both code paths
 * catch stale state before wasting a scout cycle.
 *
 * Returns the count and details of steps advanced.
 */
export function preVerifyAndAdvanceSteps(
  trajectory: Trajectory,
  state: TrajectoryState,
  cwd: string,
  exec: CommandExecutor,
): PreVerifyResult {
  const completedSteps: PreVerifyResult['completedSteps'] = [];
  const maxIterations = trajectory.steps.length;
  for (let i = 0; i < maxIterations; i++) {
    const step = getNextStep(trajectory, state.stepStates);
    if (!step || step.verification_commands.length === 0) break;

    let allPass = true;
    for (const cmd of step.verification_commands) {
      const r = exec(cmd, cwd);
      // Git-context resilience: skip commands that fail due to missing git repo
      if (r.exitCode !== 0 && !r.timedOut && r.output.includes('not a git repository')) {
        continue;
      }
      if (r.exitCode !== 0 || r.timedOut) {
        allPass = false;
        break;
      }
    }
    if (!allPass) break;

    const ss = state.stepStates[step.id];
    if (!ss) break;
    ss.status = 'completed';
    ss.completedAt = Date.now();
    completedSteps.push({ id: step.id, title: step.title });

    const next = getNextStep(trajectory, state.stepStates);
    state.currentStepId = next?.id ?? null;
    if (next && state.stepStates[next.id]) {
      state.stepStates[next.id].status = 'active';
    }
  }
  return { advanced: completedSteps.length, completedSteps };
}

// ---------------------------------------------------------------------------
// State initialization
// ---------------------------------------------------------------------------

/** Create initial step states for a trajectory. */
export function createInitialStepStates(trajectory: Trajectory): Record<string, StepState> {
  const states: Record<string, StepState> = {};
  for (const step of trajectory.steps) {
    states[step.id] = {
      stepId: step.id,
      status: 'pending',
      cyclesAttempted: 0,
      lastAttemptedCycle: 0,
    };
  }
  return states;
}

// ---------------------------------------------------------------------------
// YAML serialization (inverse of parseTrajectoryYaml)
// ---------------------------------------------------------------------------

/** Quote a YAML string value if it contains characters that would break the hand-rolled parser. */
function yamlQuote(value: string): string {
  // Quote if the value contains: colon-space, leading/trailing quotes, #, or starts with special YAML chars
  if (/[:#]/.test(value) || /^['"[\]{}&*!|>%@`]/.test(value) || value.includes('\n')) {
    // Use double quotes, escaping internal double quotes and backslashes
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

/** Serialize a Trajectory to YAML that parseTrajectoryYaml can round-trip. */
export function serializeTrajectoryToYaml(trajectory: Trajectory): string {
  const lines: string[] = [];
  lines.push(`name: ${yamlQuote(trajectory.name)}`);
  lines.push(`description: ${yamlQuote(trajectory.description)}`);
  lines.push('steps:');

  for (const step of trajectory.steps) {
    lines.push(`  - id: ${step.id}`);
    lines.push(`    title: ${yamlQuote(step.title)}`);
    lines.push(`    description: ${yamlQuote(step.description)}`);
    if (step.scope) {
      lines.push(`    scope: "${step.scope}"`);
    }
    if (step.categories && step.categories.length > 0) {
      lines.push(`    categories: [${step.categories.join(', ')}]`);
    }
    lines.push('    acceptance_criteria:');
    for (const ac of step.acceptance_criteria) {
      lines.push(`      - ${yamlQuote(ac)}`);
    }
    lines.push('    verification_commands:');
    for (const vc of step.verification_commands) {
      lines.push(`      - ${yamlQuote(vc)}`);
    }
    lines.push(`    depends_on: [${step.depends_on.join(', ')}]`);
    if (step.max_retries !== undefined) {
      lines.push(`    max_retries: ${step.max_retries}`);
    }
    if (step.priority !== undefined) {
      lines.push(`    priority: ${step.priority}`);
    }
    if (step.measure) {
      lines.push('    measure:');
      lines.push(`      cmd: "${step.measure.cmd}"`);
      lines.push(`      target: ${step.measure.target}`);
      lines.push(`      direction: ${step.measure.direction}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
