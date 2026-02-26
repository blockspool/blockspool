/**
 * Goals — measurable targets that drive spin formula selection.
 *
 * A goal is a formula with a `measure` field. The system measures current
 * state, picks the goal with the biggest gap from target, and works toward it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  type Formula,
  parseSimpleYaml,
  parseStringList,
} from '@promptwheel/core/formulas/shared';

// ---------------------------------------------------------------------------
// Shared state-store persistence
// ---------------------------------------------------------------------------

export interface JsonStateReadOptions<T> {
  fallback: T;
  validate?: (value: unknown) => value is T;
  recoverTmp?: boolean;
}

export interface JsonStateWriteOptions {
  atomic?: boolean;
  pretty?: boolean;
  trailingNewline?: boolean;
}

export interface NdjsonReadOptions<T> {
  limit?: number;
  newestFirst?: boolean;
  parseLine?: (line: string) => T;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function recoverTmpFile(filePath: string): void {
  const tmp = filePath + '.tmp';
  if (!fs.existsSync(filePath) && fs.existsSync(tmp)) {
    try {
      fs.renameSync(tmp, filePath);
    } catch {
      // Best effort recovery
    }
  }
}

export function readJsonState<T>(filePath: string, options: JsonStateReadOptions<T>): T {
  try {
    if (options.recoverTmp) {
      recoverTmpFile(filePath);
    }
    if (!fs.existsSync(filePath)) {
      return options.fallback;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (options.validate && !options.validate(parsed)) {
      return options.fallback;
    }
    return parsed as T;
  } catch {
    return options.fallback;
  }
}

export function writeJsonState(filePath: string, value: unknown, options: JsonStateWriteOptions = {}): void {
  const atomic = options.atomic ?? true;
  const pretty = options.pretty ?? true;
  const trailingNewline = options.trailingNewline ?? false;
  const serialized = pretty
    ? JSON.stringify(value, null, 2)
    : JSON.stringify(value);
  const payload = trailingNewline ? `${serialized}\n` : serialized;

  ensureParentDir(filePath);
  if (!atomic) {
    fs.writeFileSync(filePath, payload, 'utf-8');
    return;
  }

  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, payload, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    throw err;
  }
}

export function appendNdjsonState(filePath: string, value: unknown): void {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, JSON.stringify(value) + '\n', 'utf-8');
}

export function readNdjsonState<T>(filePath: string, options: NdjsonReadOptions<T> = {}): T[] {
  if (!fs.existsSync(filePath)) return [];

  const parseLine = options.parseLine ?? ((line: string) => JSON.parse(line) as T);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(line => line.trim().length > 0);
  const entries: T[] = [];

  if (options.newestFirst) {
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        entries.push(parseLine(lines[i]));
      } catch {
        // Skip malformed lines
      }
      if (options.limit && entries.length >= options.limit) break;
    }
    return entries;
  }

  for (const line of lines) {
    try {
      entries.push(parseLine(line));
    } catch {
      // Skip malformed lines
    }
    if (options.limit && entries.length >= options.limit) break;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoalMeasurement {
  goalName: string;
  current: number | null;  // null = measurement failed
  target: number;
  direction: 'up' | 'down';
  gapPercent: number;       // 0-100, how far from target (0 = met)
  met: boolean;
  error?: string;
  measuredAt: number;       // timestamp
}

export interface GoalState {
  measurements: Record<string, GoalMeasurementEntry[]>;  // ring buffer per goal
  lastUpdated: number;
}

interface GoalMeasurementEntry {
  value: number | null;
  timestamp: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load goal files from `.promptwheel/goals/*.yaml`, return formulas with measure fields.
 */
export function loadGoals(repoRoot: string): Formula[] {
  const goalsDir = path.join(repoRoot, '.promptwheel', 'goals');
  if (!fs.existsSync(goalsDir)) return [];

  const files = fs.readdirSync(goalsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const goals: Formula[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(goalsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseSimpleYaml(content);

      const name = parsed.name || path.basename(file, path.extname(file));
      const measureCmd = parsed.measure_cmd;
      const measureTarget = parsed.measure_target ? parseFloat(parsed.measure_target) : undefined;
      const measureDirection = parsed.measure_direction as 'up' | 'down' | undefined;

      if (!measureCmd || measureTarget === undefined || !measureDirection) {
        continue; // skip goals missing required measure fields
      }

      const formula: Formula = {
        name,
        description: parsed.description || `Goal: ${name}`,
        categories: parsed.categories ? parseStringList(parsed.categories) : undefined,
        prompt: parsed.prompt,
        minConfidence: parsed.min_confidence ? parseInt(parsed.min_confidence, 10) : undefined,
        min_confidence: parsed.min_confidence ? parseInt(parsed.min_confidence, 10) : undefined,
        measure: {
          cmd: measureCmd,
          target: measureTarget,
          direction: measureDirection,
        },
      };

      goals.push(formula);
    } catch {
      // Skip malformed goal files
    }
  }

  return goals;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Run a measurement command and parse the last number from its output.
 * Returns null if the command fails or produces no parseable number.
 */
export function runMeasurement(cmd: string, repoRoot: string): { value: number | null; error?: string } {
  try {
    const output = execFileSync('sh', ['-c', cmd], {
      cwd: repoRoot,
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Find the last number in the output
    const matches = output.match(/-?\d+\.?\d*/g);
    if (!matches || matches.length === 0) {
      return { value: null, error: 'No numeric output' };
    }

    const value = parseFloat(matches[matches.length - 1]);
    if (isNaN(value)) {
      return { value: null, error: 'Could not parse number' };
    }

    return { value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Truncate long error messages
    const shortMsg = message.length > 100 ? message.slice(0, 100) + '...' : message;
    return { value: null, error: shortMsg };
  }
}

/**
 * Measure all goals, compute gaps.
 */
export function measureGoals(goals: Formula[], repoRoot: string): GoalMeasurement[] {
  const measurements: GoalMeasurement[] = [];

  for (const goal of goals) {
    if (!goal.measure) continue;

    const { value, error } = runMeasurement(goal.measure.cmd, repoRoot);
    const { target, direction } = goal.measure;

    let gapPercent = 100;
    let met = false;

    if (value !== null) {
      if (direction === 'up') {
        // Higher is better: gap = how far below target
        if (value >= target) {
          gapPercent = 0;
          met = true;
        } else if (target !== 0) {
          gapPercent = ((target - value) / target) * 100;
        } else {
          // target is 0 and value < 0: gap is 100% (can't be below zero target)
          gapPercent = 100;
        }
      } else {
        // Lower is better: gap = how far above target
        if (value <= target) {
          gapPercent = 0;
          met = true;
        } else if (target > 0) {
          // Non-zero target: normalize against target so progress is visible
          // target=10, value=15 → 50%; value=12 → 20%; value=10 → 0%
          gapPercent = Math.min(100, ((value - target) / target) * 100);
        } else {
          // target=0: use absolute difference capped to 100 so progress is visible
          // value=50 → 50%, value=10 → 10%, value=1 → 1%
          gapPercent = Math.min(100, value - target);
        }
      }
    }

    measurements.push({
      goalName: goal.name,
      current: value,
      target,
      direction,
      gapPercent: Math.round(gapPercent * 10) / 10,
      met,
      error,
      measuredAt: Date.now(),
    });
  }

  return measurements;
}

/**
 * Pick the goal with the biggest gap from target.
 * Skips met goals and errored goals.
 */
export function pickGoalByGap(measurements: GoalMeasurement[]): GoalMeasurement | null {
  const candidates = measurements
    .filter(m => !m.met && m.current !== null)
    .sort((a, b) => b.gapPercent - a.gapPercent);

  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

/**
 * Format goal context for injection into the scout prompt.
 */
export function formatGoalContext(goal: Formula, measurement: GoalMeasurement): string {
  const arrow = measurement.direction === 'up' ? '↑' : '↓';
  const unit = measurement.direction === 'up' ? 'higher is better' : 'lower is better';
  return [
    `<goal>`,
    `Active goal: ${goal.name}`,
    `${goal.description}`,
    `Current: ${measurement.current} | Target: ${measurement.target} (${arrow} ${unit})`,
    `Gap: ${measurement.gapPercent}%`,
    `</goal>`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function goalStatePath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', 'goal-state.json');
}

function emptyGoalState(): GoalState {
  return { measurements: {}, lastUpdated: 0 };
}

function isGoalState(value: unknown): value is GoalState {
  if (!value || typeof value !== 'object') return false;
  const measurements = (value as GoalState).measurements;
  return Boolean(measurements && typeof measurements === 'object' && !Array.isArray(measurements));
}

export function readGoalState(repoRoot: string): GoalState {
  return readJsonState(goalStatePath(repoRoot), {
    fallback: emptyGoalState(),
    recoverTmp: true,
    validate: isGoalState,
  });
}

export function writeGoalState(repoRoot: string, state: GoalState): void {
  state.lastUpdated = Date.now();
  writeJsonState(goalStatePath(repoRoot), state);
}

const MAX_MEASUREMENTS_PER_GOAL = 50;

/**
 * Append a measurement to the ring buffer for a goal.
 */
export function recordGoalMeasurement(repoRoot: string, measurement: GoalMeasurement): void {
  const state = readGoalState(repoRoot);
  if (!state.measurements[measurement.goalName]) {
    state.measurements[measurement.goalName] = [];
  }

  const entries = state.measurements[measurement.goalName];
  entries.push({
    value: measurement.current,
    timestamp: measurement.measuredAt,
    error: measurement.error,
  });

  // Ring buffer: keep only the last N entries
  if (entries.length > MAX_MEASUREMENTS_PER_GOAL) {
    state.measurements[measurement.goalName] = entries.slice(-MAX_MEASUREMENTS_PER_GOAL);
  }

  writeGoalState(repoRoot, state);
}
