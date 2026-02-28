/**
 * Trajectory algorithm tests — covers all pure functions in trajectory/shared.ts:
 *   - stepReady
 *   - getNextStep
 *   - trajectoryComplete
 *   - trajectoryStuck
 *   - formatTrajectoryForPrompt
 *   - parseTrajectoryYaml
 *   - createInitialStepStates
 *
 * Tests pure functions only (no filesystem).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  stepReady,
  getNextStep,
  getReadySteps,
  trajectoryComplete,
  trajectoryFullySucceeded,
  trajectoryStuck,
  formatTrajectoryForPrompt,
  parseTrajectoryYaml,
  serializeTrajectoryToYaml,
  createInitialStepStates,
  detectCycle,
  enforceGraphOrdering,
  type Trajectory,
  type TrajectoryStep,
  type StepState,
} from '../trajectory/shared.js';

function makeStep(partial: Partial<TrajectoryStep> & Pick<TrajectoryStep, 'id'>): TrajectoryStep {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    description: partial.description ?? '',
    scope: partial.scope,
    categories: partial.categories,
    acceptance_criteria: partial.acceptance_criteria ?? [],
    verification_commands: partial.verification_commands ?? [],
    depends_on: partial.depends_on ?? [],
    max_retries: partial.max_retries,
    priority: partial.priority,
    measure: partial.measure,
  };
}

function makeTrajectory(steps: TrajectoryStep[], overrides?: Partial<Trajectory>): Trajectory {
  return {
    name: overrides?.name ?? 'Test Trajectory',
    description: overrides?.description ?? 'A test trajectory.',
    steps,
  };
}

// ---------------------------------------------------------------------------
// stepReady
// ---------------------------------------------------------------------------

describe('stepReady', () => {
  it('returns true when depends_on is empty (even if states is empty)', () => {
    const step = makeStep({ id: 'a', depends_on: [] });
    expect(stepReady(step, {})).toBe(true);
  });

  it('returns false when a dependency is missing from states', () => {
    const step = makeStep({ id: 'b', depends_on: ['a'] });
    expect(stepReady(step, {})).toBe(false);
  });

  it('returns false when a dependency is not completed', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };
    const step = makeStep({ id: 'b', depends_on: ['a'] });
    expect(stepReady(step, states)).toBe(false);
  });

  it('treats skipped dependencies as ready (skipping unblocks dependents)', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'skipped', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };
    const step = makeStep({ id: 'b', depends_on: ['a'] });
    expect(stepReady(step, states)).toBe(true);
  });

  it('returns true when all dependencies are completed', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'completed', cyclesAttempted: 1, lastAttemptedCycle: 1, completedAt: Date.now() },
    };
    const step = makeStep({ id: 'b', depends_on: ['a'] });
    expect(stepReady(step, states)).toBe(true);
  });

  it('requires all multi-dependencies to be satisfied (mixed skipped + pending)', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'skipped', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      b: { stepId: 'b', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };
    const step = makeStep({ id: 'c', depends_on: ['a', 'b'] });
    expect(stepReady(step, states)).toBe(false);
  });

  it('returns true when all multi-dependencies are skipped', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'skipped', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      b: { stepId: 'b', status: 'skipped', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };
    const step = makeStep({ id: 'c', depends_on: ['a', 'b'] });
    expect(stepReady(step, states)).toBe(true);
  });

  it('returns true with mixed completed + skipped dependencies', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'completed', cyclesAttempted: 1, lastAttemptedCycle: 1, completedAt: Date.now() },
      b: { stepId: 'b', status: 'skipped', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };
    const step = makeStep({ id: 'c', depends_on: ['a', 'b'] });
    expect(stepReady(step, states)).toBe(true);
  });

  it('treats failed dependencies as resolved (auto-skip unblocks dependents)', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'failed', cyclesAttempted: 3, lastAttemptedCycle: 3, failureReason: 'max retries' },
    };
    const step = makeStep({ id: 'b', depends_on: ['a'] });
    expect(stepReady(step, states)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getNextStep
// ---------------------------------------------------------------------------

describe('getNextStep', () => {
  it('returns the first ready step in declaration order (pending)', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', depends_on: ['a'] }),
    ]);
    const states = createInitialStepStates(trajectory);

    const next = getNextStep(trajectory, states);
    expect(next?.id).toBe('a');
  });

  it('returns the first ready step after completed/skipped/failed steps', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', depends_on: ['a'] }),
      makeStep({ id: 'c' }),
    ]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';

    const next = getNextStep(trajectory, states);
    // b is ready (depends on a completed) and appears before c.
    expect(next?.id).toBe('b');
  });

  it('skips steps that are pending/active but not ready and continues to later ready steps', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'blocked', depends_on: ['missing'] }),
      makeStep({ id: 'ready' }),
    ]);
    const states = createInitialStepStates(trajectory);

    const next = getNextStep(trajectory, states);
    expect(next?.id).toBe('ready');
  });

  it('does not return failed steps', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b' }),
    ]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'failed';

    const next = getNextStep(trajectory, states);
    expect(next?.id).toBe('b');
  });

  it('returns null for an empty trajectory', () => {
    const trajectory = makeTrajectory([]);
    const next = getNextStep(trajectory, {});
    expect(next).toBeNull();
  });

  it('returns null when all steps are blocked by circular dependencies', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a', depends_on: ['b'] }),
      makeStep({ id: 'b', depends_on: ['a'] }),
    ]);
    const states = createInitialStepStates(trajectory);

    const next = getNextStep(trajectory, states);
    expect(next).toBeNull();
  });

  it('picks up dependent step after dependency is skipped', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', depends_on: ['a'] }),
      makeStep({ id: 'c', depends_on: ['b'] }),
    ]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';
    states.b.status = 'skipped';

    const next = getNextStep(trajectory, states);
    expect(next?.id).toBe('c');
  });
});

// ---------------------------------------------------------------------------
// trajectoryComplete
// ---------------------------------------------------------------------------

describe('trajectoryComplete', () => {
  it('treats an empty trajectory as complete', () => {
    const trajectory = makeTrajectory([]);
    expect(trajectoryComplete(trajectory, {})).toBe(true);
  });

  it('returns true when all steps are completed or skipped', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' })]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';
    states.b.status = 'skipped';

    expect(trajectoryComplete(trajectory, states)).toBe(true);
  });

  it('returns false when any step is pending or active', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' }), makeStep({ id: 'c' })]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';
    states.b.status = 'active';
    states.c.status = 'failed';

    expect(trajectoryComplete(trajectory, states)).toBe(false);
  });

  it('returns true when all steps are in terminal states (completed, skipped, or failed)', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' }), makeStep({ id: 'c' })]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';
    states.b.status = 'failed';
    states.c.status = 'skipped';

    expect(trajectoryComplete(trajectory, states)).toBe(true);
  });

  it('returns false when a step state is missing', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' })]);
    expect(trajectoryComplete(trajectory, {})).toBe(false);
  });

  it('returns true when all steps are skipped (none completed)', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' })]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'skipped';
    states.b.status = 'skipped';
    expect(trajectoryComplete(trajectory, states)).toBe(true);
  });

  it('returns true when one step is failed and others are completed (all terminal)', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' })]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';
    states.b.status = 'failed';
    expect(trajectoryComplete(trajectory, states)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// trajectoryFullySucceeded
// ---------------------------------------------------------------------------

describe('trajectoryFullySucceeded', () => {
  it('returns true when all steps are completed', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' })]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';
    states.b.status = 'completed';
    expect(trajectoryFullySucceeded(trajectory, states)).toBe(true);
  });

  it('returns false when any step is failed', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' })]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';
    states.b.status = 'failed';
    expect(trajectoryFullySucceeded(trajectory, states)).toBe(false);
  });

  it('returns true when all steps are completed or skipped', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' })]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';
    states.b.status = 'skipped';
    expect(trajectoryFullySucceeded(trajectory, states)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// trajectoryStuck
// ---------------------------------------------------------------------------

describe('trajectoryStuck', () => {
  it('returns null when no active step exceeds retry threshold', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'active', cyclesAttempted: 2, lastAttemptedCycle: 2 },
      b: { stepId: 'b', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      c: { stepId: 'c', status: 'failed', cyclesAttempted: 10, lastAttemptedCycle: 10 },
    };
    expect(trajectoryStuck(states)).toBeNull();
  });

  it('returns the step id when an active step reaches default max retries (3)', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'active', cyclesAttempted: 3, lastAttemptedCycle: 3 },
    };
    expect(trajectoryStuck(states)).toBe('a');
  });

  it('respects custom maxRetries', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'active', cyclesAttempted: 4, lastAttemptedCycle: 4 },
    };
    expect(trajectoryStuck(states, 5)).toBeNull();
    expect(trajectoryStuck(states, 4)).toBe('a');
  });

  it('ignores non-active steps even if cyclesAttempted is high', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'failed', cyclesAttempted: 999, lastAttemptedCycle: 999 },
      b: { stepId: 'b', status: 'completed', cyclesAttempted: 999, lastAttemptedCycle: 999, completedAt: Date.now() },
    };
    expect(trajectoryStuck(states)).toBeNull();
  });

  it('uses per-step max_retries when steps are provided', () => {
    const steps = [
      makeStep({ id: 'a', max_retries: 5 }),
      makeStep({ id: 'b', max_retries: 2 }),
    ];
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'active', cyclesAttempted: 4, lastAttemptedCycle: 4 },
      b: { stepId: 'b', status: 'active', cyclesAttempted: 2, lastAttemptedCycle: 2 },
    };
    // a has 4 attempts but its limit is 5 — not stuck
    // b has 2 attempts and its limit is 2 — stuck
    expect(trajectoryStuck(states, 3, steps)).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// formatTrajectoryForPrompt
// ---------------------------------------------------------------------------

describe('formatTrajectoryForPrompt', () => {
  it('formats trajectory context with completed/current/upcoming sections and step overrides', () => {
    const step1 = makeStep({ id: 'setup', title: 'Setup', description: 'Prepare the repo.', depends_on: [] });
    const step2 = makeStep({
      id: 'refactor',
      title: 'Refactor',
      description: 'Refactor the core module.',
      scope: 'packages/core/**',
      categories: ['type-safety', 'cleanup'],
      acceptance_criteria: ['No implicit any', 'Add unit tests'],
      depends_on: ['setup'],
      measure: { cmd: 'echo 12', target: 10, direction: 'up' },
    });
    const step3 = makeStep({ id: 'polish', title: 'Polish', description: 'Polish remaining edges.', depends_on: ['refactor'] });
    const trajectory = makeTrajectory([step1, step2, step3], { name: 'Quality Sweep', description: 'Incrementally raise quality.' });

    const states = createInitialStepStates(trajectory);
    states.setup.status = 'completed';
    states.refactor.status = 'active';
    states.refactor.cyclesAttempted = 2;

    const formatted = formatTrajectoryForPrompt(trajectory, states, step2);

    expect(formatted).toContain('<trajectory>');
    expect(formatted).toContain('## Trajectory: Quality Sweep');
    expect(formatted).toContain('Incrementally raise quality.');

    // Completed step list
    expect(formatted).toContain('### Completed Steps');
    expect(formatted).toContain('- [x] Setup');

    // Current step focus block
    expect(formatted).toContain('### Current Step (FOCUS HERE)');
    expect(formatted).toContain('**Refactor**');
    expect(formatted).toContain('Refactor the core module.');
    expect(formatted).toContain('**Acceptance Criteria:**');
    expect(formatted).toContain('- No implicit any');
    expect(formatted).toContain('- Add unit tests');
    expect(formatted).toContain('**Scope:** `packages/core/**`');
    expect(formatted).toContain('**Categories:** type-safety, cleanup');
    expect(formatted).toContain('**Measure:** target >= 10');
    expect(formatted).toContain('**Attempts:** 2/3 cycle(s)');

    // Upcoming steps include dependency hints by id
    expect(formatted).toContain('### Upcoming Steps');
    expect(formatted).toContain('- [ ] Polish (after: refactor)');
    expect(formatted).not.toContain('- [ ] Refactor');

    expect(formatted).toContain('Proposals should advance the **current step** toward its acceptance criteria.');
    expect(formatted).toContain('</trajectory>');
  });

  it('omits Completed Steps section when none are completed', () => {
    const step = makeStep({ id: 'a', title: 'A', description: 'A', acceptance_criteria: [], depends_on: [] });
    const trajectory = makeTrajectory([step]);
    const states = createInitialStepStates(trajectory);

    const formatted = formatTrajectoryForPrompt(trajectory, states, step);
    expect(formatted).not.toContain('### Completed Steps');
  });

  it('shows attempts with per-step max_retries in prompt', () => {
    const step = makeStep({
      id: 'a',
      title: 'Test',
      description: 'Test step.',
      depends_on: [],
      max_retries: 5,
    });
    const trajectory = makeTrajectory([step]);
    const states = createInitialStepStates(trajectory);
    states['a'].cyclesAttempted = 2;

    const formatted = formatTrajectoryForPrompt(trajectory, states, step);
    expect(formatted).toContain('**Attempts:** 2/5 cycle(s)');
  });

  it('renders a down-direction measure using <=', () => {
    const step = makeStep({
      id: 'a',
      title: 'Reduce',
      description: 'Reduce failures.',
      depends_on: [],
      measure: { cmd: 'echo 5', target: 1, direction: 'down' },
    });
    const trajectory = makeTrajectory([step]);
    const states = createInitialStepStates(trajectory);

    const formatted = formatTrajectoryForPrompt(trajectory, states, step);
    expect(formatted).toContain('**Measure:** target <= 1');
  });
});

// ---------------------------------------------------------------------------
// parseTrajectoryYaml
// ---------------------------------------------------------------------------

describe('parseTrajectoryYaml', () => {
  it('parses a trajectory YAML document (including lists and measure)', () => {
    const yaml = `# Sample trajectory
name: my-trajectory
description: Improve reliability
steps:
  - id: step1
    title: Setup
    description: Prepare things
    scope: "packages/core/**"
    categories: [fix, test]
    acceptance_criteria:
      - Add tests
      - Green CI
    verification_commands:
      - npm test
    depends_on: []
    measure:
      cmd: "echo 12"
      target: 10
      direction: up

  - id: step2
    title: Next
    description: Do next
    depends_on: [step1]
    acceptance_criteria:
      - Ship
    verification_commands:
      - echo ok
`;

    const result = parseTrajectoryYaml(yaml);
    expect(result.name).toBe('my-trajectory');
    expect(result.description).toBe('Improve reliability');
    expect(result.steps).toHaveLength(2);

    const s1 = result.steps[0]!;
    expect(s1.id).toBe('step1');
    expect(s1.title).toBe('Setup');
    expect(s1.description).toBe('Prepare things');
    expect(s1.scope).toBe('packages/core/**');
    expect(s1.categories).toEqual(['fix', 'test']);
    expect(s1.acceptance_criteria).toEqual(['Add tests', 'Green CI']);
    expect(s1.verification_commands).toEqual(['npm test']);
    expect(s1.depends_on).toEqual([]);
    expect(s1.measure).toEqual({ cmd: 'echo 12', target: 10, direction: 'up' });

    const s2 = result.steps[1]!;
    expect(s2.id).toBe('step2');
    expect(s2.depends_on).toEqual(['step1']);
    expect(s2.acceptance_criteria).toEqual(['Ship']);
    expect(s2.verification_commands).toEqual(['echo ok']);
  });

  it('handles empty input', () => {
    const result = parseTrajectoryYaml('');
    expect(result).toEqual({ name: '', description: '', steps: [] });
  });

  it('ignores malformed/incomplete steps (missing id)', () => {
    const yaml = `name: t
description: d
steps:
  - id:
    title: Missing id value
    description: should be ignored
  - id: ok
    title: OK
    description: Works
    acceptance_criteria:
      - A
    verification_commands:
      - echo ok
    depends_on: []
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.id).toBe('ok');
  });

  it('does not set measure unless cmd, target, and direction are all present', () => {
    const yaml = `name: t
description: d
steps:
  - id: s1
    title: S1
    description: d
    acceptance_criteria:
      - A
    verification_commands:
      - echo ok
    depends_on: []
    measure:
      cmd: echo 1
      target: 10
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.measure).toBeUndefined();
  });

  it('parses comma-separated inline lists (categories, depends_on)', () => {
    const yaml = `name: t
description: d
steps:
  - id: a
    title: A
    description: d
    categories: security, test
    depends_on: x, y
    acceptance_criteria:
      - A
    verification_commands:
      - echo ok
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.categories).toEqual(['security', 'test']);
    expect(result.steps[0]!.depends_on).toEqual(['x', 'y']);
  });

  it('defaults list fields to empty arrays when list keys are present but empty', () => {
    const yaml = `name: t
description: d
steps:
  - id: a
    title: A
    description: d
    acceptance_criteria:
    verification_commands:
    depends_on: []
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.acceptance_criteria).toEqual([]);
    expect(result.steps[0]!.verification_commands).toEqual([]);
  });

  it('parses max_retries field', () => {
    const yaml = `name: t
description: d
steps:
  - id: a
    title: A
    description: d
    max_retries: 5
  - id: b
    title: B
    description: d
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.max_retries).toBe(5);
    expect(result.steps[1]!.max_retries).toBeUndefined();
  });

  it('ignores invalid max_retries values', () => {
    const yaml = `name: t
description: d
steps:
  - id: a
    title: A
    description: d
    max_retries: -1
  - id: b
    title: B
    description: d
    max_retries: abc
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps[0]!.max_retries).toBeUndefined();
    expect(result.steps[1]!.max_retries).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectCycle
// ---------------------------------------------------------------------------

describe('detectCycle', () => {
  it('returns null when there are no cycles', () => {
    const steps = [
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', depends_on: ['a'] }),
      makeStep({ id: 'c', depends_on: ['b'] }),
    ];
    expect(detectCycle(steps)).toBeNull();
  });

  it('detects a simple A↔B cycle', () => {
    const steps = [
      makeStep({ id: 'a', depends_on: ['b'] }),
      makeStep({ id: 'b', depends_on: ['a'] }),
    ];
    const result = detectCycle(steps);
    expect(result).not.toBeNull();
    expect(result).toContain('a');
    expect(result).toContain('b');
  });

  it('detects a longer chain cycle (A→B→C→A)', () => {
    const steps = [
      makeStep({ id: 'a', depends_on: ['c'] }),
      makeStep({ id: 'b', depends_on: ['a'] }),
      makeStep({ id: 'c', depends_on: ['b'] }),
    ];
    const result = detectCycle(steps);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
  });

  it('detects a single node self-dependency', () => {
    const steps = [
      makeStep({ id: 'a', depends_on: ['a'] }),
    ];
    const result = detectCycle(steps);
    expect(result).not.toBeNull();
    expect(result).toContain('a');
  });

  it('returns null for an empty step list', () => {
    expect(detectCycle([])).toBeNull();
  });

  it('returns null for independent steps (no deps)', () => {
    const steps = [
      makeStep({ id: 'a' }),
      makeStep({ id: 'b' }),
      makeStep({ id: 'c' }),
    ];
    expect(detectCycle(steps)).toBeNull();
  });

  it('handles disconnected DAG components (no false positive)', () => {
    const steps = [
      makeStep({ id: 'a', depends_on: ['b'] }),
      makeStep({ id: 'b' }),
      makeStep({ id: 'c', depends_on: ['d'] }),
      makeStep({ id: 'd' }),
    ];
    expect(detectCycle(steps)).toBeNull();
  });

  it('ignores depends_on referencing non-existent step (not a cycle)', () => {
    const steps = [
      makeStep({ id: 'a', depends_on: ['missing'] }),
      makeStep({ id: 'b' }),
    ];
    expect(detectCycle(steps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createInitialStepStates
// ---------------------------------------------------------------------------

describe('createInitialStepStates', () => {
  it('creates pending state for each step', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' })]);
    const states = createInitialStepStates(trajectory);

    expect(Object.keys(states).sort()).toEqual(['a', 'b']);
    expect(states.a).toEqual({ stepId: 'a', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 });
    expect(states.b).toEqual({ stepId: 'b', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 });
  });

  it('returns an empty object for an empty trajectory', () => {
    const trajectory = makeTrajectory([]);
    expect(createInitialStepStates(trajectory)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// serializeTrajectoryToYaml
// ---------------------------------------------------------------------------

describe('serializeTrajectoryToYaml', () => {
  it('round-trips through parseTrajectoryYaml', () => {
    const trajectory: Trajectory = {
      name: 'test-roundtrip',
      description: 'Ensure serialization round-trips',
      steps: [
        {
          id: 'setup',
          title: 'Setup infrastructure',
          description: 'Install dependencies and configure',
          scope: 'packages/core/**',
          categories: ['fix', 'test'],
          acceptance_criteria: ['Tests pass', 'Build succeeds'],
          verification_commands: ['npm test', 'npm run build'],
          depends_on: [],
          measure: { cmd: 'echo 5', target: 10, direction: 'up' },
        },
        {
          id: 'implement',
          title: 'Implement feature',
          description: 'Build the core logic',
          acceptance_criteria: ['Feature works'],
          verification_commands: ['npm test'],
          depends_on: ['setup'],
        },
      ],
    };

    const yaml = serializeTrajectoryToYaml(trajectory);
    const parsed = parseTrajectoryYaml(yaml);

    expect(parsed.name).toBe(trajectory.name);
    expect(parsed.description).toBe(trajectory.description);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0].id).toBe('setup');
    expect(parsed.steps[0].scope).toBe('packages/core/**');
    expect(parsed.steps[0].categories).toEqual(['fix', 'test']);
    expect(parsed.steps[0].acceptance_criteria).toEqual(['Tests pass', 'Build succeeds']);
    expect(parsed.steps[0].verification_commands).toEqual(['npm test', 'npm run build']);
    expect(parsed.steps[0].depends_on).toEqual([]);
    expect(parsed.steps[0].measure).toEqual({ cmd: 'echo 5', target: 10, direction: 'up' });
    expect(parsed.steps[1].id).toBe('implement');
    expect(parsed.steps[1].depends_on).toEqual(['setup']);
  });

  it('handles steps without optional fields', () => {
    const trajectory: Trajectory = {
      name: 'minimal',
      description: 'Minimal trajectory',
      steps: [
        {
          id: 'only-step',
          title: 'Do something',
          description: 'Just do it',
          acceptance_criteria: ['Done'],
          verification_commands: ['echo ok'],
          depends_on: [],
        },
      ],
    };

    const yaml = serializeTrajectoryToYaml(trajectory);
    const parsed = parseTrajectoryYaml(yaml);

    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].id).toBe('only-step');
    expect(parsed.steps[0].scope).toBeUndefined();
    expect(parsed.steps[0].categories).toBeUndefined();
    expect(parsed.steps[0].measure).toBeUndefined();
  });

  it('round-trips priority field', () => {
    const trajectory: Trajectory = {
      name: 'priority-test',
      description: 'Test priority',
      steps: [
        {
          id: 'high',
          title: 'High priority',
          description: 'Important',
          acceptance_criteria: ['Done'],
          verification_commands: ['echo ok'],
          depends_on: [],
          priority: 9,
        },
        {
          id: 'low',
          title: 'Low priority',
          description: 'Less important',
          acceptance_criteria: ['Done'],
          verification_commands: ['echo ok'],
          depends_on: [],
          priority: 2,
        },
      ],
    };

    const yaml = serializeTrajectoryToYaml(trajectory);
    const parsed = parseTrajectoryYaml(yaml);

    expect(parsed.steps[0].priority).toBe(9);
    expect(parsed.steps[1].priority).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getNextStep — priority-based ordering
// ---------------------------------------------------------------------------

describe('getNextStep with priorities', () => {
  it('picks highest-priority ready step when multiple steps are ready', () => {
    const steps = [
      makeStep({ id: 'low', priority: 3 }),
      makeStep({ id: 'high', priority: 8 }),
      makeStep({ id: 'med', priority: 5 }),
    ];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      low: { stepId: 'low', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      high: { stepId: 'high', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      med: { stepId: 'med', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };

    const next = getNextStep(traj, states);
    expect(next?.id).toBe('high');
  });

  it('falls back to declaration order when priorities are equal', () => {
    const steps = [
      makeStep({ id: 'first' }),
      makeStep({ id: 'second' }),
    ];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      first: { stepId: 'first', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      second: { stepId: 'second', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };

    const next = getNextStep(traj, states);
    expect(next?.id).toBe('first');
  });

  it('skips completed steps even if they have higher priority', () => {
    const steps = [
      makeStep({ id: 'done', priority: 10 }),
      makeStep({ id: 'pending', priority: 3 }),
    ];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      done: { stepId: 'done', status: 'completed', cyclesAttempted: 1, lastAttemptedCycle: 1, completedAt: 1 },
      pending: { stepId: 'pending', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };

    const next = getNextStep(traj, states);
    expect(next?.id).toBe('pending');
  });

  it('respects dependencies even with higher priority', () => {
    const steps = [
      makeStep({ id: 'blocker', priority: 2 }),
      makeStep({ id: 'dependent', priority: 10, depends_on: ['blocker'] }),
    ];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      blocker: { stepId: 'blocker', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      dependent: { stepId: 'dependent', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };

    const next = getNextStep(traj, states);
    expect(next?.id).toBe('blocker');
  });
});

// ---------------------------------------------------------------------------
// parseTrajectoryYaml — empty/missing id handling
// ---------------------------------------------------------------------------

describe('parseTrajectoryYaml empty id handling', () => {
  it('drops step with empty id and warns', () => {
    const yaml = `name: test
description: test
steps:
  - id:
    title: No ID Step
    description: Should be dropped
  - id: valid
    title: Valid Step
    description: Should be kept
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseTrajectoryYaml(yaml);
    // Only the valid step should be present
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].id).toBe('valid');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No ID Step'));
    warnSpy.mockRestore();
  });

  it('keeps all steps when all have valid ids', () => {
    const yaml = `name: test
description: test
steps:
  - id: step-a
    title: A
    description: d
  - id: step-b
    title: B
    description: d
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// YAML quoting round-trip — special characters
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getReadySteps
// ---------------------------------------------------------------------------

describe('getReadySteps', () => {
  it('returns all ready steps sorted by priority', () => {
    const steps = [
      makeStep({ id: 'low', priority: 2 }),
      makeStep({ id: 'high', priority: 9 }),
      makeStep({ id: 'med', priority: 5 }),
    ];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      low: { stepId: 'low', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      high: { stepId: 'high', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      med: { stepId: 'med', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };

    const ready = getReadySteps(traj, states);
    expect(ready).toHaveLength(3);
    expect(ready[0].id).toBe('high');
    expect(ready[1].id).toBe('med');
    expect(ready[2].id).toBe('low');
  });

  it('excludes completed and blocked steps', () => {
    const steps = [
      makeStep({ id: 'done' }),
      makeStep({ id: 'blocked', depends_on: ['pending'] }),
      makeStep({ id: 'pending' }),
    ];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      done: { stepId: 'done', status: 'completed', cyclesAttempted: 1, lastAttemptedCycle: 1, completedAt: 1 },
      blocked: { stepId: 'blocked', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      pending: { stepId: 'pending', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };

    const ready = getReadySteps(traj, states);
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('pending');
  });

  it('returns empty array when all steps are terminal', () => {
    const steps = [makeStep({ id: 'a' }), makeStep({ id: 'b' })];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'completed', cyclesAttempted: 1, lastAttemptedCycle: 1, completedAt: 1 },
      b: { stepId: 'b', status: 'failed', cyclesAttempted: 3, lastAttemptedCycle: 3, failureReason: 'stuck' },
    };

    expect(getReadySteps(traj, states)).toHaveLength(0);
  });

  it('unblocks multiple steps when shared dependency completes', () => {
    const steps = [
      makeStep({ id: 'root' }),
      makeStep({ id: 'branch-a', depends_on: ['root'], priority: 7 }),
      makeStep({ id: 'branch-b', depends_on: ['root'], priority: 3 }),
    ];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      root: { stepId: 'root', status: 'completed', cyclesAttempted: 1, lastAttemptedCycle: 1, completedAt: 1 },
      'branch-a': { stepId: 'branch-a', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      'branch-b': { stepId: 'branch-b', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };

    const ready = getReadySteps(traj, states);
    expect(ready).toHaveLength(2);
    expect(ready[0].id).toBe('branch-a'); // higher priority first
    expect(ready[1].id).toBe('branch-b');
  });
});

// ---------------------------------------------------------------------------
// formatTrajectoryForPrompt — verification output and consecutive failures
// ---------------------------------------------------------------------------

describe('formatTrajectoryForPrompt with step diagnostics', () => {
  it('includes lastVerificationOutput in prompt when present', () => {
    const steps = [makeStep({ id: 'a', verification_commands: ['npm test'] })];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      a: {
        stepId: 'a', status: 'active', cyclesAttempted: 2, lastAttemptedCycle: 2,
        lastVerificationOutput: '$ npm test (exit 1)\nError: test failed',
      },
    };

    const prompt = formatTrajectoryForPrompt(traj, states, steps[0]);
    expect(prompt).toContain('Last verification output');
    expect(prompt).toContain('Error: test failed');
  });

  it('shows consecutive failure warning when >= 2', () => {
    const steps = [makeStep({ id: 'a' })];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      a: {
        stepId: 'a', status: 'active', cyclesAttempted: 3, lastAttemptedCycle: 3,
        consecutiveFailures: 3,
      },
    };

    const prompt = formatTrajectoryForPrompt(traj, states, steps[0]);
    expect(prompt).toContain('failed 3 consecutive times');
    expect(prompt).toContain('Try a different approach');
  });

  it('does not show warning for single failure', () => {
    const steps = [makeStep({ id: 'a' })];
    const traj = makeTrajectory(steps);
    const states: Record<string, StepState> = {
      a: {
        stepId: 'a', status: 'active', cyclesAttempted: 1, lastAttemptedCycle: 1,
        consecutiveFailures: 1,
      },
    };

    const prompt = formatTrajectoryForPrompt(traj, states, steps[0]);
    expect(prompt).not.toContain('consecutive times');
  });
});

// ---------------------------------------------------------------------------
// trajectoryStuck — flakiness detection
// ---------------------------------------------------------------------------

describe('trajectoryStuck flakiness detection', () => {
  it('detects flaky step when totalFailures exceeds 2x max_retries', () => {
    const states: Record<string, StepState> = {
      a: {
        stepId: 'a', status: 'active', cyclesAttempted: 2, lastAttemptedCycle: 5,
        consecutiveFailures: 1, // low consecutive (resets on pass)
        totalFailures: 7, // high total (alternating pass/fail)
      },
    };
    const steps = [makeStep({ id: 'a', max_retries: 3 })];
    const stuck = trajectoryStuck(states, 3, steps);
    expect(stuck).toBe('a'); // flaky: 7 >= 3*2
  });

  it('does not flag flaky when totalFailures is within range', () => {
    const states: Record<string, StepState> = {
      a: {
        stepId: 'a', status: 'active', cyclesAttempted: 2, lastAttemptedCycle: 3,
        consecutiveFailures: 1,
        totalFailures: 4, // within 2 * 3 = 6
      },
    };
    const steps = [makeStep({ id: 'a', max_retries: 3 })];
    const stuck = trajectoryStuck(states, 3, steps);
    expect(stuck).toBeNull();
  });
});

describe('serializeTrajectoryToYaml special character round-trip', () => {
  it('round-trips description containing a colon', () => {
    const trajectory: Trajectory = {
      name: 'test',
      description: 'cleanup: remove dead code',
      steps: [{
        id: 'step-1',
        title: 'Fix auth: token refresh',
        description: 'Refactor the auth module: handle edge cases',
        acceptance_criteria: ['All tests pass: no regressions'],
        verification_commands: ['echo ok'],
        depends_on: [],
      }],
    };
    const yaml = serializeTrajectoryToYaml(trajectory);
    const parsed = parseTrajectoryYaml(yaml);
    expect(parsed.name).toBe('test');
    expect(parsed.description).toBe('cleanup: remove dead code');
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].title).toBe('Fix auth: token refresh');
    expect(parsed.steps[0].description).toBe('Refactor the auth module: handle edge cases');
    expect(parsed.steps[0].acceptance_criteria[0]).toBe('All tests pass: no regressions');
  });

  it('round-trips strings containing hash characters', () => {
    const trajectory: Trajectory = {
      name: 'test',
      description: 'Fix issue #42',
      steps: [{
        id: 's1',
        title: 'Resolve #42',
        description: 'Address the bug reported in #42',
        acceptance_criteria: [],
        verification_commands: [],
        depends_on: [],
      }],
    };
    const yaml = serializeTrajectoryToYaml(trajectory);
    const parsed = parseTrajectoryYaml(yaml);
    expect(parsed.description).toBe('Fix issue #42');
    expect(parsed.steps[0].title).toBe('Resolve #42');
  });

  it('round-trips strings without special characters unquoted', () => {
    const trajectory: Trajectory = {
      name: 'simple-name',
      description: 'A simple description',
      steps: [{
        id: 's1',
        title: 'Simple step',
        description: 'Nothing special here',
        acceptance_criteria: ['Tests pass'],
        verification_commands: ['npm test'],
        depends_on: [],
      }],
    };
    const yaml = serializeTrajectoryToYaml(trajectory);
    // Simple strings should NOT be quoted
    expect(yaml).toContain('name: simple-name');
    expect(yaml).toContain('title: Simple step');
    const parsed = parseTrajectoryYaml(yaml);
    expect(parsed.name).toBe('simple-name');
    expect(parsed.steps[0].title).toBe('Simple step');
  });
});

// ---------------------------------------------------------------------------
// enforceGraphOrdering
// ---------------------------------------------------------------------------

describe('enforceGraphOrdering', () => {
  it('adds depends_on when step B imports a module touched by step A', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a', scope: 'packages/core/' }),
      makeStep({ id: 'b', scope: 'packages/cli/' }),
    ]);
    const edges: Record<string, string[]> = {
      'packages/cli/src/lib': ['packages/core/src'],
    };
    const result = enforceGraphOrdering(trajectory, edges);
    // B (cli) imports A (core), so B should depend on A
    expect(result.steps[1].depends_on).toContain('a');
  });

  it('does not add duplicate depends_on if already present', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a', scope: 'packages/core/' }),
      makeStep({ id: 'b', scope: 'packages/cli/', depends_on: ['a'] }),
    ]);
    const edges: Record<string, string[]> = {
      'packages/cli/src': ['packages/core/src'],
    };
    const result = enforceGraphOrdering(trajectory, edges);
    const deps = result.steps[1].depends_on.filter(d => d === 'a');
    expect(deps).toHaveLength(1);
  });

  it('skips edge that would create a cycle', () => {
    // A depends on B already. If B's module imports A's module, adding B→A would cycle.
    const trajectory = makeTrajectory([
      makeStep({ id: 'a', scope: 'packages/core/', depends_on: ['b'] }),
      makeStep({ id: 'b', scope: 'packages/cli/' }),
    ]);
    const edges: Record<string, string[]> = {
      // cli imports core → would want b→a, but a already depends on b
      'packages/cli/src': ['packages/core/src'],
    };
    const result = enforceGraphOrdering(trajectory, edges);
    // Should NOT have added a→b (already exists) or b→a (would cycle)
    expect(result.steps[0].depends_on).toEqual(['b']);
    expect(result.steps[1].depends_on).toEqual([]);
  });

  it('returns trajectory unchanged when edges are empty', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a', scope: 'packages/core/' }),
      makeStep({ id: 'b', scope: 'packages/cli/' }),
    ]);
    const result = enforceGraphOrdering(trajectory, {});
    expect(result.steps[0].depends_on).toEqual([]);
    expect(result.steps[1].depends_on).toEqual([]);
  });

  it('handles steps with no scope gracefully', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', scope: 'packages/cli/' }),
    ]);
    const edges: Record<string, string[]> = {
      'packages/cli/src': ['packages/core/src'],
    };
    const result = enforceGraphOrdering(trajectory, edges);
    // Step A has no scope → no modules → no edges added
    expect(result.steps[0].depends_on).toEqual([]);
    expect(result.steps[1].depends_on).toEqual([]);
  });

  it('does not mutate the original trajectory', () => {
    const original = makeTrajectory([
      makeStep({ id: 'a', scope: 'packages/core/' }),
      makeStep({ id: 'b', scope: 'packages/cli/' }),
    ]);
    const edges: Record<string, string[]> = {
      'packages/cli/src': ['packages/core/src'],
    };
    const result = enforceGraphOrdering(original, edges);
    // Original should be unmodified
    expect(original.steps[1].depends_on).toEqual([]);
    // Result should have the new edge
    expect(result.steps[1].depends_on).toContain('a');
  });
});

