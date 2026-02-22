/**
 * Trajectory I/O — load YAML definitions, persist state.
 *
 * Trajectories live in `.promptwheel/trajectories/<name>.yaml`.
 * State is persisted to `.promptwheel/trajectory-state.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Trajectory, TrajectoryState } from '@promptwheel/core/trajectory/shared';
import {
  parseTrajectoryYaml,
  createInitialStepStates,
  getNextStep,
  detectCycle,
} from '@promptwheel/core/trajectory/shared';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function trajectoriesDir(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', 'trajectories');
}

function trajectoryStatePath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', 'trajectory-state.json');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Load all trajectory definitions from `.promptwheel/trajectories/`. */
export function loadTrajectories(repoRoot: string): Trajectory[] {
  const dir = trajectoriesDir(repoRoot);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const trajectories: Trajectory[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const trajectory = parseTrajectoryYaml(content);
      if (trajectory.name && trajectory.steps.length > 0) {
        trajectories.push(trajectory);
      }
    } catch (err) {
      console.warn(`Warning: failed to load trajectory ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return trajectories;
}

/** Load a single trajectory by name. Tries slug-based lookup first for O(1), falls back to scan. */
export function loadTrajectory(repoRoot: string, name: string): Trajectory | null {
  const dir = trajectoriesDir(repoRoot);
  if (!fs.existsSync(dir)) return null;

  // Fast path: try slug-based file lookup (uses same logic as slugify in trajectory-generate.ts)
  const rawSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const tsMatch = rawSlug.match(/-(\d{13})$/);
  const slug = tsMatch
    ? rawSlug.slice(0, rawSlug.length - 14).slice(0, 66) + '-' + tsMatch[1]
    : rawSlug.slice(0, 80);
  for (const ext of ['.yaml', '.yml']) {
    const filePath = path.join(dir, `${slug}${ext}`);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const trajectory = parseTrajectoryYaml(content);
        if (trajectory.name === name && trajectory.steps.length > 0) return trajectory;
      } catch { /* fall through to scan */ }
    }
  }

  // Fallback: full scan
  const trajectories = loadTrajectories(repoRoot);
  return trajectories.find(t => t.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

/** Load the active trajectory state, or null if none. */
export function loadTrajectoryState(repoRoot: string): TrajectoryState | null {
  const p = trajectoryStatePath(repoRoot);
  try {
    // Recover from crash: if .tmp exists but main file doesn't, restore it
    const tmp = p + '.tmp';
    if (!fs.existsSync(p) && fs.existsSync(tmp)) {
      try { fs.renameSync(tmp, p); } catch { /* best effort */ }
    }
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      if (!raw.trim()) return null;
      const data = JSON.parse(raw);
      // Structural validation — reject malformed state that passed JSON.parse
      if (
        !data ||
        typeof data !== 'object' ||
        typeof data.trajectoryName !== 'string' ||
        typeof data.stepStates !== 'object' ||
        data.stepStates === null
      ) {
        return null;
      }
      return data as TrajectoryState;
    }
  } catch {
    // Corrupted file — return null
  }
  return null;
}

/** Save trajectory state to disk. */
export function saveTrajectoryState(repoRoot: string, state: TrajectoryState): void {
  const p = trajectoryStatePath(repoRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    // Clean up orphaned .tmp on failure
    if (fs.existsSync(tmp)) try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Clear trajectory state (deactivate). */
export function clearTrajectoryState(repoRoot: string): void {
  const p = trajectoryStatePath(repoRoot);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** Activate a trajectory: create initial step states and save. */
export function activateTrajectory(repoRoot: string, name: string): TrajectoryState | null {
  const trajectory = loadTrajectory(repoRoot, name);
  if (!trajectory) return null;

  // Reject trajectories with circular dependencies
  const cycle = detectCycle(trajectory.steps);
  if (cycle) {
    console.warn(`Cannot activate trajectory "${name}": circular dependency detected: ${cycle.join(' → ')}`);
    return null;
  }

  const stepStates = createInitialStepStates(trajectory);
  const firstStep = getNextStep(trajectory, stepStates);

  if (firstStep) {
    stepStates[firstStep.id].status = 'active';
  }

  const state: TrajectoryState = {
    trajectoryName: name,
    startedAt: Date.now(),
    stepStates,
    currentStepId: firstStep?.id ?? null,
    paused: false,
  };

  saveTrajectoryState(repoRoot, state);
  return state;
}
