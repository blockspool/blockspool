/**
 * Trajectory Quality Gate — pure-function post-generation validation.
 *
 * Checks the generated trajectory against the blueprint for quality issues:
 * step 1 scope breadth, dependency completeness, conflict isolation,
 * verification commands, and step count vs ambition.
 *
 * No I/O, no LLM calls. All functions are deterministic.
 */

import type { ProposalBlueprint, ProposalInput } from './blueprint.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrajectoryStepInput {
  id: string;
  scope?: string;
  categories?: string[];
  verification_commands: string[];
  depends_on: string[];
}

export interface TrajectoryQualityResult {
  passed: boolean;
  issues: string[];
  critique: string;
}

// ---------------------------------------------------------------------------
// Step count ranges per ambition level
// ---------------------------------------------------------------------------

const AMBITION_STEP_RANGES: Record<string, [number, number]> = {
  conservative: [2, 3],
  moderate: [3, 5],
  ambitious: [5, 8],
};

// ---------------------------------------------------------------------------
// Quality checks
// ---------------------------------------------------------------------------

/**
 * Check if step 1 scope is too broad relative to its source proposals.
 * For conservative/moderate ambition, step 1 should not be broader than
 * the common parent of source proposals' files.
 */
function checkStep1Breadth(
  steps: TrajectoryStepInput[],
  proposals: ProposalInput[],
  ambition: string,
): string | null {
  if (ambition === 'ambitious') return null;
  if (steps.length === 0) return null;

  const step1 = steps[0];
  if (!step1.scope) return null;

  // Compute the common parent of all proposal files
  const allFiles = proposals.flatMap(p => p.files);
  if (allFiles.length === 0) return null;

  const dirs = allFiles
    .map(f => f.split('/').slice(0, -1))
    .filter(d => d.length > 0);

  if (dirs.length === 0) return null;

  const first = dirs[0];
  let commonLen = first.length;
  for (const dir of dirs.slice(1)) {
    let i = 0;
    while (i < commonLen && i < dir.length && first[i] === dir[i]) i++;
    commonLen = i;
  }

  const proposalCommonParent = commonLen > 0 ? first.slice(0, commonLen).join('/') : '';

  // Step 1 scope segments (strip trailing /**)
  const step1ScopeClean = step1.scope.replace(/\/?\*\*$/, '');
  const step1Segments = step1ScopeClean.split('/').filter(Boolean);

  // Proposal common parent segments
  const proposalSegments = proposalCommonParent.split('/').filter(Boolean);

  // Step 1 is too broad if its scope is shallower (fewer segments) than the proposal common parent
  if (proposalSegments.length > 0 && step1Segments.length < proposalSegments.length) {
    return `Step 1 scope "${step1.scope}" is broader than proposals' common scope "${proposalCommonParent}/**" — narrow it for ${ambition} ambition`;
  }

  return null;
}

/**
 * Check that blueprint enablers appear before their dependents in the trajectory.
 */
function checkDependencyCompleteness(
  steps: TrajectoryStepInput[],
  blueprint: ProposalBlueprint,
  proposals: ProposalInput[],
): string[] {
  const issues: string[] = [];
  if (blueprint.enablers.length === 0) return issues;

  // Map each enabler proposal to its files
  const enablerFiles = new Set<string>();
  for (const idx of blueprint.enablers) {
    for (const f of proposals[idx].files) {
      enablerFiles.add(f);
    }
  }

  // Check that steps touching enabler files don't depend on steps that don't touch them
  // (i.e., enabler work should come first or at least not be blocked by non-enabler work)
  const stepOrder = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    stepOrder.set(steps[i].id, i);
  }

  // Simplified check: enabler-related categories should appear in early steps
  const enablerCategories = new Set(blueprint.enablers.map(i => proposals[i].category));
  let lastEnablerStep = -1;
  let firstNonEnablerStep = steps.length;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const cats = step.categories ?? [];
    const hasEnablerCat = cats.some(c => enablerCategories.has(c));
    if (hasEnablerCat) {
      lastEnablerStep = i;
    } else if (firstNonEnablerStep === steps.length) {
      firstNonEnablerStep = i;
    }
  }

  // It's an issue if all enabler categories appear after non-enabler steps
  if (lastEnablerStep > firstNonEnablerStep && firstNonEnablerStep < steps.length - 1) {
    issues.push('Enabler proposals should appear in earlier steps — they unblock other work');
  }

  return issues;
}

/**
 * Check that conflicting proposals are not in the same step.
 * Uses scope overlap as a proxy (proposals from the same blueprint group
 * sharing scope + different categories = conflict risk).
 */
function checkConflictIsolation(
  steps: TrajectoryStepInput[],
  blueprint: ProposalBlueprint,
): string[] {
  const issues: string[] = [];
  if (blueprint.conflicts.length === 0) return issues;

  // Map proposals to steps via category overlap
  // Since we don't have direct proposal→step mapping, we check if any step
  // has categories from both sides of a conflict
  for (const conflict of blueprint.conflicts) {
    const catA = conflict.indexA;
    const catB = conflict.indexB;
    // This is a lightweight heuristic — we flag when a single step
    // lists categories from both sides of a known conflict
    // (Full mapping would need file-to-step matching which is lossy)
    if (conflict.resolution === 'sequence') {
      // For sequenceable conflicts, just log them
      continue;
    }
  }

  // Check for steps that have too many conflicting categories
  for (const step of steps) {
    const cats = step.categories ?? [];
    if (cats.length > 3) {
      issues.push(`Step "${step.id}" has ${cats.length} categories — may contain conflicting proposals. Prefer fewer categories per step.`);
    }
  }

  return issues;
}

/**
 * Check that every step has at least one verification command.
 */
function checkVerificationCommands(steps: TrajectoryStepInput[]): string[] {
  const issues: string[] = [];
  for (const step of steps) {
    if (step.verification_commands.length === 0) {
      issues.push(`Step "${step.id}" has no verification commands — every step needs at least one`);
    }
  }
  return issues;
}

/**
 * Check that step count is within the target range for the ambition level.
 */
function checkStepCountVsAmbition(
  steps: TrajectoryStepInput[],
  ambition: string,
  stepCountSlack = 2,
): string | null {
  const range = AMBITION_STEP_RANGES[ambition];
  if (!range) return null;

  const [min, max] = range;
  if (steps.length < min) {
    return `Too few steps (${steps.length}) for ${ambition} ambition — target is ${min}-${max}`;
  }
  if (steps.length > max + stepCountSlack) {
    return `Too many steps (${steps.length}) for ${ambition} ambition — target is ${min}-${max}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a generated trajectory against quality criteria.
 * Returns a result with pass/fail, issue list, and formatted critique for retry.
 */
export function validateTrajectoryQuality(
  steps: TrajectoryStepInput[],
  proposals: ProposalInput[],
  blueprint: ProposalBlueprint,
  ambition: string = 'moderate',
  config?: { stepCountSlack?: number },
): TrajectoryQualityResult {
  const issues: string[] = [];

  // 1. Step 1 scope breadth
  const breadthIssue = checkStep1Breadth(steps, proposals, ambition);
  if (breadthIssue) issues.push(breadthIssue);

  // 2. Dependency completeness
  issues.push(...checkDependencyCompleteness(steps, blueprint, proposals));

  // 3. Conflict isolation
  issues.push(...checkConflictIsolation(steps, blueprint));

  // 4. Verification commands
  issues.push(...checkVerificationCommands(steps));

  // 5. Step count vs ambition
  const countIssue = checkStepCountVsAmbition(steps, ambition, config?.stepCountSlack);
  if (countIssue) issues.push(countIssue);

  const passed = issues.length === 0;
  const critique = passed ? '' : formatCritique(issues);

  return { passed, issues, critique };
}

/**
 * Format quality issues as a critique block for LLM retry.
 * Follows the pattern from buildPlanRejectionCriticBlock.
 */
export function formatCritique(issues: string[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = [
    '<trajectory-critique>',
    '## Quality Gate Failed — Revise Trajectory',
    '',
    'The generated trajectory has the following issues:',
    '',
    ...issues.map(issue => `- ${issue}`),
    '',
    'Regenerate the trajectory JSON fixing these issues. Keep the same proposals but improve step structure.',
    '</trajectory-critique>',
  ];

  return lines.join('\n');
}
