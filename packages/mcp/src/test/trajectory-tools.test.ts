/**
 * Tests for trajectory tools: list, show, activate, pause, resume, skip, reset.
 *
 * Creates real trajectory YAML files and state on disk, then tests
 * the trajectory I/O and state management functions directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadTrajectories,
  loadTrajectory,
  loadTrajectoryState,
  saveTrajectoryState,
  clearTrajectoryState,
  activateTrajectory,
} from '../trajectory-io.js';
import { getNextStep } from '@promptwheel/core/trajectory/shared';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-traj-test-'));
  // Create .promptwheel/trajectories/ directory
  const trajDir = path.join(tmpDir, '.promptwheel', 'trajectories');
  fs.mkdirSync(trajDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTrajectory(name: string, content: string) {
  const trajDir = path.join(tmpDir, '.promptwheel', 'trajectories');
  fs.writeFileSync(path.join(trajDir, `${name}.yaml`), content, 'utf-8');
}

const SIMPLE_TRAJECTORY = `name: test-traj
description: A test trajectory
steps:
  - id: step-1
    title: First step
    description: Do the first thing
    scope: src/**
    categories: [refactor]
    acceptance_criteria:
      - Code compiles
    verification_commands:
      - npm test
  - id: step-2
    title: Second step
    description: Do the second thing
    scope: lib/**
    categories: [test]
    acceptance_criteria:
      - Tests pass
    verification_commands:
      - npm test
    depends_on: [step-1]
`;

const SIMPLE_NO_DEPS = `name: no-deps
description: No dependencies
steps:
  - id: alpha
    title: Alpha step
    description: Independent step
    scope: "src/**"
    categories:
      - fix
    acceptance_criteria:
      - Fixed
    verification_commands:
      - npm test
`;

// ── loadTrajectories ────────────────────────────────────────────────────────

describe('trajectory_list (loadTrajectories)', () => {
  it('returns empty array when no trajectories exist', () => {
    const trajDir = path.join(tmpDir, '.promptwheel', 'trajectories');
    // Remove any files
    for (const f of fs.readdirSync(trajDir)) {
      fs.unlinkSync(path.join(trajDir, f));
    }
    const result = loadTrajectories(tmpDir);
    expect(result).toEqual([]);
  });

  it('loads trajectory from YAML file', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    const result = loadTrajectories(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('test-traj');
    expect(result[0].steps).toHaveLength(2);
  });

  it('loads multiple trajectories', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    writeTrajectory('no-deps', SIMPLE_NO_DEPS);
    const result = loadTrajectories(tmpDir);
    expect(result).toHaveLength(2);
    const names = result.map(t => t.name).sort();
    expect(names).toEqual(['no-deps', 'test-traj']);
  });

  it('skips invalid YAML files', () => {
    writeTrajectory('bad', 'this is not valid yaml at all {{{{');
    writeTrajectory('good', SIMPLE_NO_DEPS);
    const result = loadTrajectories(tmpDir);
    // Should load at least the good one
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array when directory does not exist', () => {
    const noDir = path.join(tmpDir, 'nonexistent');
    const result = loadTrajectories(noDir);
    expect(result).toEqual([]);
  });
});

// ── loadTrajectory (single) ─────────────────────────────────────────────────

describe('trajectory_show (loadTrajectory)', () => {
  it('loads a specific trajectory by name', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    const result = loadTrajectory(tmpDir, 'test-traj');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('test-traj');
    expect(result!.description).toBe('A test trajectory');
    expect(result!.steps).toHaveLength(2);
  });

  it('returns null for non-existent trajectory', () => {
    const result = loadTrajectory(tmpDir, 'nonexistent');
    expect(result).toBeNull();
  });

  it('includes step details', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    const result = loadTrajectory(tmpDir, 'test-traj');
    const step1 = result!.steps[0];
    expect(step1.id).toBe('step-1');
    expect(step1.title).toBe('First step');
    expect(step1.scope).toBe('src/**');
    expect(step1.categories).toContain('refactor');
    expect(step1.verification_commands).toContain('npm test');
  });

  it('includes dependency information', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    const result = loadTrajectory(tmpDir, 'test-traj');
    const step2 = result!.steps[1];
    expect(step2.depends_on).toContain('step-1');
  });
});

// ── activateTrajectory ──────────────────────────────────────────────────────

describe('trajectory_activate (activateTrajectory)', () => {
  it('activates a trajectory and sets first step as active', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    const state = activateTrajectory(tmpDir, 'test-traj');
    expect(state).not.toBeNull();
    expect(state!.trajectoryName).toBe('test-traj');
    expect(state!.currentStepId).toBe('step-1');
    expect(state!.paused).toBe(false);
    expect(state!.stepStates['step-1'].status).toBe('active');
    expect(state!.stepStates['step-2'].status).toBe('pending');
  });

  it('returns null for non-existent trajectory', () => {
    const state = activateTrajectory(tmpDir, 'nonexistent');
    expect(state).toBeNull();
  });

  it('persists state to disk', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    activateTrajectory(tmpDir, 'test-traj');
    const loaded = loadTrajectoryState(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.trajectoryName).toBe('test-traj');
  });

  it('rejects trajectory with circular dependencies', () => {
    const circular = `name: circular
description: Has circular deps
steps:
  - id: a
    title: Step A
    description: Goes to B
    scope: src/**
    categories: [fix]
    acceptance_criteria:
      - done
    verification_commands:
      - npm test
    depends_on: [b]
  - id: b
    title: Step B
    description: Goes to A
    scope: src/**
    categories: [fix]
    acceptance_criteria:
      - done
    verification_commands:
      - npm test
    depends_on: [a]
`;
    writeTrajectory('circular', circular);
    const state = activateTrajectory(tmpDir, 'circular');
    expect(state).toBeNull();
  });
});

// ── pause / resume ──────────────────────────────────────────────────────────

describe('trajectory_pause / trajectory_resume', () => {
  it('pauses an active trajectory', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    activateTrajectory(tmpDir, 'test-traj');

    const state = loadTrajectoryState(tmpDir)!;
    expect(state.paused).toBe(false);

    state.paused = true;
    saveTrajectoryState(tmpDir, state);

    const reloaded = loadTrajectoryState(tmpDir)!;
    expect(reloaded.paused).toBe(true);
  });

  it('resumes a paused trajectory', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    activateTrajectory(tmpDir, 'test-traj');

    const state = loadTrajectoryState(tmpDir)!;
    state.paused = true;
    saveTrajectoryState(tmpDir, state);

    const paused = loadTrajectoryState(tmpDir)!;
    expect(paused.paused).toBe(true);

    paused.paused = false;
    saveTrajectoryState(tmpDir, paused);

    const resumed = loadTrajectoryState(tmpDir)!;
    expect(resumed.paused).toBe(false);
  });

  it('returns null when no state file exists (no trajectory to pause)', () => {
    const state = loadTrajectoryState(tmpDir);
    expect(state).toBeNull();
  });
});

// ── skip ────────────────────────────────────────────────────────────────────

describe('trajectory_skip', () => {
  it('marks a step as skipped', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    activateTrajectory(tmpDir, 'test-traj');

    const state = loadTrajectoryState(tmpDir)!;
    expect(state.stepStates['step-1'].status).toBe('active');

    state.stepStates['step-1'].status = 'skipped';
    state.stepStates['step-1'].completedAt = Date.now();

    // Advance to next step
    const trajectory = loadTrajectory(tmpDir, 'test-traj')!;
    const next = getNextStep(trajectory, state.stepStates);
    if (next) {
      state.stepStates[next.id].status = 'active';
      state.currentStepId = next.id;
    }

    saveTrajectoryState(tmpDir, state);

    const reloaded = loadTrajectoryState(tmpDir)!;
    expect(reloaded.stepStates['step-1'].status).toBe('skipped');
    expect(reloaded.currentStepId).toBe('step-2');
    expect(reloaded.stepStates['step-2'].status).toBe('active');
  });

  it('sets currentStepId to null when last step is skipped', () => {
    writeTrajectory('no-deps', SIMPLE_NO_DEPS);
    activateTrajectory(tmpDir, 'no-deps');

    const state = loadTrajectoryState(tmpDir)!;
    state.stepStates['alpha'].status = 'skipped';
    state.stepStates['alpha'].completedAt = Date.now();

    const trajectory = loadTrajectory(tmpDir, 'no-deps')!;
    const next = getNextStep(trajectory, state.stepStates);
    if (next) {
      state.stepStates[next.id].status = 'active';
      state.currentStepId = next.id;
    } else {
      state.currentStepId = null;
    }

    saveTrajectoryState(tmpDir, state);

    const reloaded = loadTrajectoryState(tmpDir)!;
    expect(reloaded.currentStepId).toBeNull();
  });
});

// ── reset ───────────────────────────────────────────────────────────────────

describe('trajectory_reset (clearTrajectoryState)', () => {
  it('clears active trajectory state', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    activateTrajectory(tmpDir, 'test-traj');

    expect(loadTrajectoryState(tmpDir)).not.toBeNull();

    clearTrajectoryState(tmpDir);

    expect(loadTrajectoryState(tmpDir)).toBeNull();
  });

  it('is idempotent when no state exists', () => {
    // Should not throw
    clearTrajectoryState(tmpDir);
    expect(loadTrajectoryState(tmpDir)).toBeNull();
  });
});

// ── state persistence edge cases ────────────────────────────────────────────

describe('trajectory state persistence', () => {
  it('handles empty state file gracefully', () => {
    const statePath = path.join(tmpDir, '.promptwheel', 'trajectory-state.json');
    fs.writeFileSync(statePath, '', 'utf-8');
    const state = loadTrajectoryState(tmpDir);
    expect(state).toBeNull();
  });

  it('handles malformed JSON gracefully', () => {
    const statePath = path.join(tmpDir, '.promptwheel', 'trajectory-state.json');
    fs.writeFileSync(statePath, '{ invalid json', 'utf-8');
    const state = loadTrajectoryState(tmpDir);
    expect(state).toBeNull();
  });

  it('handles missing required fields gracefully', () => {
    const statePath = path.join(tmpDir, '.promptwheel', 'trajectory-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ foo: 'bar' }), 'utf-8');
    const state = loadTrajectoryState(tmpDir);
    expect(state).toBeNull();
  });

  it('recovers from .tmp file when main file is missing', () => {
    writeTrajectory('test-traj', SIMPLE_TRAJECTORY);
    activateTrajectory(tmpDir, 'test-traj');

    const mainPath = path.join(tmpDir, '.promptwheel', 'trajectory-state.json');
    const tmpPath = mainPath + '.tmp';

    // Simulate crash: rename main to .tmp, delete main
    const content = fs.readFileSync(mainPath, 'utf-8');
    fs.writeFileSync(tmpPath, content);
    fs.unlinkSync(mainPath);

    const recovered = loadTrajectoryState(tmpDir);
    expect(recovered).not.toBeNull();
    expect(recovered!.trajectoryName).toBe('test-traj');
  });
});
