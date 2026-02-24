/**
 * Trajectory auto-generation — uses an LLM to decompose a high-level goal
 * into an ordered, multi-step trajectory YAML.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClaude, parseClaudeOutput } from '@promptwheel/core/scout';
import { buildCodebaseIndex, formatIndexForPrompt } from './codebase-index.js';
import { detectProjectMetadata, formatMetadataForPrompt } from './project-metadata/index.js';
import {
  serializeTrajectoryToYaml,
  parseTrajectoryYaml,
  detectCycle,
  type Trajectory,
  type TrajectoryStep,
} from '@promptwheel/core/trajectory/shared';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  goal: string;
  repoRoot: string;
  model?: string;
  timeoutMs?: number;
}

export interface GenerateFromProposalsOptions {
  proposals: Array<{
    title: string;
    description: string;
    category: string;
    files: string[];
    allowed_paths: string[];
    acceptance_criteria: string[];
    verification_commands: string[];
    confidence: number;
    impact_score?: number;
    rationale: string;
    estimated_complexity: string;
  }>;
  repoRoot: string;
  model?: string;
  timeoutMs?: number;
  /** Summary of previous drill trajectories to avoid repeating themes */
  previousTrajectories?: string;
  /** Hint about categories/scopes already covered for diversity */
  diversityHint?: string;
  /** Sector layout of the codebase for spatial organization */
  sectorContext?: string;
  /** Project taste profile — preferred/avoided categories and complexity */
  tasteContext?: string;
  /** Cross-run learnings relevant to trajectory planning */
  learningsContext?: string;
  /** Recently completed/attempted proposals to avoid re-proposing */
  dedupContext?: string;
  /** Active goal with current measurement — trajectory should align with this */
  goalContext?: string;
  /** Drill health metrics hint — informs LLM about what works well/poorly */
  metricsHint?: string;
  /** Dependency edges subgraph relevant to proposals — helps LLM order steps */
  dependencyEdges?: string;
  /** Causal context from the last trajectory — what was changed and what's now unblocked */
  causalContext?: string;
  /** Adaptive ambition level — scales first-step complexity based on track record */
  ambitionLevel?: 'conservative' | 'moderate' | 'ambitious';
  /** Escalation context — repeatedly-failed proposals that need decomposition into smaller steps */
  escalationContext?: string;
  /** Convergence signal — hints about whether to widen scope, deepen, or keep short */
  convergenceHint?: string;
  /** Current session phase — cooldown triggers shorter trajectories */
  sessionPhase?: string;
}

export interface GenerateResult {
  trajectory: Trajectory;
  yaml: string;
  filePath: string;
}

export async function generateTrajectory(opts: GenerateOptions): Promise<GenerateResult> {
  // 1. Build codebase context
  const excludeDirs = ['node_modules', 'dist', 'build', '.git', '.promptwheel', 'coverage', '__pycache__'];
  const codebaseIndex = buildCodebaseIndex(opts.repoRoot, excludeDirs, true);
  const projectMeta = detectProjectMetadata(opts.repoRoot);

  const indexBlock = formatIndexForPrompt(codebaseIndex, 0);
  const metaBlock = formatMetadataForPrompt(projectMeta);

  // 2. Build prompt
  const prompt = buildGeneratePrompt(opts.goal, indexBlock, metaBlock);

  // 3. Call LLM
  const result = await runClaude({
    prompt,
    cwd: opts.repoRoot,
    timeoutMs: opts.timeoutMs ?? 120_000,
    model: opts.model ?? 'sonnet',
  });

  if (!result.success) {
    throw new Error(`LLM call failed: ${result.error}`);
  }

  // 4. Parse JSON response
  const parsed = parseClaudeOutput<{ name: string; description: string; steps: unknown[] }>(result.output);
  if (!parsed || !parsed.name || !parsed.steps?.length) {
    throw new Error(`Failed to parse trajectory from LLM output (name: ${parsed?.name ?? 'missing'}, steps: ${parsed?.steps?.length ?? 0})`);
  }

  // 5. Validate and build Trajectory
  const trajectory = validateAndBuild(parsed);

  // 6. Serialize to YAML
  const yaml = serializeTrajectoryToYaml(trajectory);

  // 7. Verify round-trip
  const roundTripped = parseTrajectoryYaml(yaml);
  if (roundTripped.steps.length !== trajectory.steps.length) {
    throw new Error('YAML round-trip validation failed');
  }

  // 8. Write to disk
  const slug = slugify(trajectory.name);
  const dir = path.join(opts.repoRoot, '.promptwheel', 'trajectories');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}.yaml`);
  fs.writeFileSync(filePath, yaml, 'utf-8');

  return { trajectory, yaml, filePath };
}

/**
 * Generate a trajectory from scout proposals (used by drill mode).
 * Clusters and sequences proposals into ordered trajectory steps.
 */
export async function generateTrajectoryFromProposals(opts: GenerateFromProposalsOptions): Promise<GenerateResult> {
  // 1. Build codebase context
  let indexBlock: string;
  let metaBlock: string;
  try {
    const excludeDirs = ['node_modules', 'dist', 'build', '.git', '.promptwheel', 'coverage', '__pycache__'];
    const codebaseIndex = buildCodebaseIndex(opts.repoRoot, excludeDirs, true);
    const projectMeta = detectProjectMetadata(opts.repoRoot);
    indexBlock = formatIndexForPrompt(codebaseIndex, 0);
    metaBlock = formatMetadataForPrompt(projectMeta);
  } catch (err) {
    throw new Error(`Trajectory generation failed during codebase indexing: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Format proposals and build prompt
  const proposalsBlock = formatProposalsForTrajectoryPrompt(opts.proposals);
  const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
    previousTrajectories: opts.previousTrajectories,
    diversityHint: opts.diversityHint,
    sectorContext: opts.sectorContext,
    tasteContext: opts.tasteContext,
    learningsContext: opts.learningsContext,
    dedupContext: opts.dedupContext,
    goalContext: opts.goalContext,
    metricsHint: opts.metricsHint,
    dependencyEdges: opts.dependencyEdges,
    causalContext: opts.causalContext,
    ambitionLevel: opts.ambitionLevel,
    escalationContext: opts.escalationContext,
    convergenceHint: opts.convergenceHint,
    sessionPhase: opts.sessionPhase,
  });

  // 3. Call LLM (sonnet for cost efficiency)
  const result = await runClaude({
    prompt,
    cwd: opts.repoRoot,
    timeoutMs: opts.timeoutMs ?? 120_000,
    model: opts.model ?? 'sonnet',
  });

  if (!result.success) {
    throw new Error(`Trajectory generation failed during LLM call: ${result.error}`);
  }

  // 4. Parse JSON response
  const parsed = parseClaudeOutput<{ name: string; description: string; steps: unknown[] }>(result.output);
  if (!parsed || !parsed.name || !parsed.steps?.length) {
    const preview = (result.output || '').slice(0, 200);
    throw new Error(`Trajectory generation failed during response parsing (name: ${parsed?.name ?? 'missing'}, steps: ${parsed?.steps?.length ?? 0}, output: "${preview}")`);
  }

  // 5. Ensure drill- prefix + timestamp for uniqueness
  const timestamp = Date.now();
  if (!parsed.name.startsWith('drill-')) {
    parsed.name = `drill-${parsed.name}`;
  }
  parsed.name = `${parsed.name}-${timestamp}`;

  // 6. Validate and build Trajectory
  let trajectory: Trajectory;
  try {
    trajectory = validateAndBuild(parsed);
  } catch (err) {
    throw new Error(`Trajectory generation failed during validation: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 7. Serialize to YAML
  const yaml = serializeTrajectoryToYaml(trajectory);

  // 8. Verify round-trip
  const roundTripped = parseTrajectoryYaml(yaml);
  if (roundTripped.steps.length !== trajectory.steps.length) {
    throw new Error('Trajectory generation failed during YAML round-trip validation');
  }

  // 9. Write to disk
  const slug = slugify(trajectory.name);
  const dir = path.join(opts.repoRoot, '.promptwheel', 'trajectories');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}.yaml`);
  fs.writeFileSync(filePath, yaml, 'utf-8');

  return { trajectory, yaml, filePath };
}

// ---------------------------------------------------------------------------
// Proposal formatting
// ---------------------------------------------------------------------------

/**
 * Compute a suggested scope glob from proposal file paths.
 * Finds the common parent directory and appends /** for a targeted scope.
 * Returns undefined if no meaningful scope can be computed.
 */
export function computeSuggestedScope(files: string[]): string | undefined {
  if (files.length === 0) return undefined;

  const dirs = files
    .map(f => f.split('/').slice(0, -1)) // drop filename, keep dir segments
    .filter(d => d.length > 0);

  if (dirs.length === 0) return undefined;

  // Find common prefix across all directory paths
  const first = dirs[0];
  let commonLen = first.length;
  for (const dir of dirs.slice(1)) {
    let i = 0;
    while (i < commonLen && i < dir.length && first[i] === dir[i]) i++;
    commonLen = i;
  }

  if (commonLen === 0) return undefined;
  return first.slice(0, commonLen).join('/') + '/**';
}

export function formatProposalsForTrajectoryPrompt(
  proposals: GenerateFromProposalsOptions['proposals'],
): string {
  return proposals.map((p, i) => {
    const impact = p.impact_score ?? 5;
    const score = (impact * (p.confidence / 100)).toFixed(1);
    const files = p.files.length > 0 ? p.files.join(', ') : p.allowed_paths.join(', ');
    const suggestedScope = computeSuggestedScope(p.files);
    const ac = p.acceptance_criteria?.length ? `\n   Acceptance: ${p.acceptance_criteria.join('; ')}` : '';
    const vc = p.verification_commands?.length ? `\n   Verification: ${p.verification_commands.join(', ')}` : '';
    return `${i + 1}. [${p.category}] ${p.title} (score: ${score}, complexity: ${p.estimated_complexity})
   Files: ${files}${suggestedScope ? `\n   Suggested scope: ${suggestedScope}` : ''}
   ${p.description}
   Rationale: ${p.rationale}${ac}${vc}`;
  }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildGeneratePrompt(goal: string, indexBlock: string, metaBlock: string): string {
  return `You are a principal engineer planning a multi-step implementation trajectory.

Given a high-level goal, decompose it into ordered steps that can each be completed in 1-3 scout cycles by an AI coding agent.

## Goal

${goal}

## Codebase Context

${metaBlock}

${indexBlock}

## Requirements

1. Each step should be:
   - Self-contained and completable independently (after its dependencies)
   - Scoped to specific files/directories (use glob patterns)
   - Have clear acceptance criteria that an AI can verify
   - Have at least one verification command that exits 0 on success

2. Steps should be ordered logically:
   - Infrastructure/setup first
   - Core implementation next
   - Integration and testing last
   - Use depends_on to express ordering constraints

3. Step IDs should be short kebab-case identifiers (e.g., "install-deps", "add-config", "impl-core")

4. Scope globs should be specific enough to guide the scout but not so narrow they miss related files. Use patterns like "src/auth/**" or "packages/core/src/*.ts".

5. Categories should be from: security, fix, perf, refactor, test, types, cleanup, docs

6. Keep it to 3-8 steps. Fewer is better if the goal is simple.

7. Assign a priority (1-10) to each step. Higher priority steps are executed first among ready steps.

8. Set max_retries per step: 1-2 for trivial steps (adding a function, fixing an import), 3 for standard work, 4-5 for complex architectural changes.

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation):

{
  "name": "kebab-case-trajectory-name",
  "description": "One-line description of the trajectory",
  "steps": [
    {
      "id": "step-id",
      "title": "Short imperative title",
      "description": "What this step accomplishes and how",
      "scope": "glob/pattern/**",
      "categories": ["refactor"],
      "acceptance_criteria": ["Criterion that can be checked"],
      "verification_commands": ["command that exits 0 on success"],
      "depends_on": [],
      "priority": 7,
      "max_retries": 3
    }
  ]
}`;
}

export function buildGenerateFromProposalsPrompt(
  proposalsBlock: string,
  indexBlock: string,
  metaBlock: string,
  context?: {
    previousTrajectories?: string;
    diversityHint?: string;
    sectorContext?: string;
    tasteContext?: string;
    learningsContext?: string;
    dedupContext?: string;
    goalContext?: string;
    metricsHint?: string;
    dependencyEdges?: string;
    causalContext?: string;
    ambitionLevel?: 'conservative' | 'moderate' | 'ambitious';
    escalationContext?: string;
    convergenceHint?: string;
    sessionPhase?: string;
  },
): string {
  const sections: string[] = [];

  sections.push(`You are a principal engineer planning a multi-step implementation trajectory from scout proposals.

Given a set of improvement proposals found by automated scouting, cluster related proposals and sequence them into an ordered trajectory that an AI coding agent can execute step by step.

## Scout Proposals

${proposalsBlock}

## Codebase Context

${metaBlock}

${indexBlock}`);

  if (context?.sectorContext) {
    sections.push(`## Codebase Sectors

The codebase is organized into these sectors. Use this to understand spatial layout and organize steps to move through related areas together.

${context.sectorContext}`);
  }

  if (context?.previousTrajectories) {
    sections.push(`## Previous Trajectories (this session)

These trajectories have already been generated and executed. DO NOT repeat the same themes or areas. Pick a different vein to drill into.

${context.previousTrajectories}`);
  }

  if (context?.diversityHint) {
    sections.push(`## Coverage So Far

${context.diversityHint}

Prefer under-explored categories and scopes. Avoid creating another trajectory in areas that have already been drilled multiple times.`);
  }

  if (context?.tasteContext) {
    sections.push(`## Project Taste Profile

This project has learned preferences from past outcomes. Respect these when choosing trajectory themes:

${context.tasteContext}`);
  }

  if (context?.learningsContext) {
    sections.push(`## Cross-Run Learnings

Insights from previous sessions. Use these to avoid repeating mistakes and build on successful patterns:

${context.learningsContext}`);
  }

  if (context?.dedupContext) {
    sections.push(`## Recently Completed/Attempted Work

These proposals have already been done or attempted. Do NOT create trajectory steps that duplicate this work:

${context.dedupContext}`);
  }

  if (context?.goalContext) {
    sections.push(`## Active Goal

The project has an active goal. Trajectory steps should align with and advance this goal when possible:

${context.goalContext}`);
  }

  if (context?.metricsHint) {
    sections.push(`## Drill Health Metrics

Historical performance data — use this to bias toward categories and patterns that succeed:

${context.metricsHint}`);
  }

  if (context?.dependencyEdges) {
    sections.push(`## Module Dependency Graph

Use this to order trajectory steps correctly — modules that are imported by others should be fixed first:

${context.dependencyEdges}`);
  }

  if (context?.causalContext) {
    sections.push(`## Trajectory Chain (recent history)

Recent trajectories made specific changes. Use this to BUILD ON that work — propose follow-up improvements, tests for newly added code, or fixes that are now unblocked:

${context.causalContext}`);
  }

  if (context?.escalationContext) {
    sections.push(`## Escalation Candidates (PRIORITY — Decompose These)

The following proposals have been attempted multiple times as single tickets but ALWAYS FAIL. They are valid improvements but too complex for a single-ticket approach. Your trajectory MUST decompose at least one of these into smaller, achievable steps.

Strategy: Break each complex change into 2-4 incremental steps. For example, "Enforce CSRF on all endpoints" becomes:
  1. Add CSRF middleware (1-2 files, middleware dir only)
  2. Wire middleware into routes (route files only)
  3. Add CSRF tests (test files only)

Each step should touch a NARROW scope (2-5 files max) and be independently verifiable.

${context.escalationContext}`);
  }

  if (context?.sessionPhase === 'cooldown') {
    sections.push(`## Session Phase Warning

**SESSION ENDING SOON:** Keep trajectory SHORT (2-3 steps) and HIGH-CONFIDENCE. Avoid ambitious multi-file changes.`);
  }

  if (context?.convergenceHint) {
    sections.push(`## System Convergence Signal

${context.convergenceHint}`);
  }

  sections.push(`## Requirements

1. Cluster related proposals into coherent steps. A step may combine 1-3 related proposals that touch the same area.

2. Each step should be:
   - Self-contained and completable independently (after its dependencies)
   - Scoped to specific files/directories (use glob patterns)
   - Have clear acceptance criteria that an AI can verify
   - Have at least one verification command that exits 0 on success

3. Steps should be ordered logically:
   - Foundation/infrastructure fixes first
   - Core improvements next
   - Testing and cleanup last
   - Use depends_on to express ordering constraints

4. Step IDs should be short kebab-case identifiers (e.g., "fix-types", "add-tests", "refactor-auth")

5. Categories should be from: security, fix, perf, refactor, test, types, cleanup, docs

6. Target step count: ${(() => {
  const a = context?.ambitionLevel ?? 'moderate';
  return a === 'conservative' ? '2-3 steps (short, high-confidence trajectory)' : a === 'ambitious' ? '5-8 steps (longer arc, more ambitious scope)' : '3-5 steps (balanced trajectory)';
})()} — merge very similar proposals into one step rather than creating many tiny steps.

7. Prioritize higher-scoring proposals. Low-scoring proposals can be dropped if they don't fit the trajectory theme.

8. Assign a priority (1-10) to each step based on impact and urgency. Higher = more important. Steps with the same dependency level will be executed in priority order.

${context?.previousTrajectories ? '9. Choose a DIFFERENT theme from previous trajectories. Explore new areas of the codebase.\n\n10' : '9'}. Set max_retries per step: 1-2 for trivial steps (adding a function, fixing an import), 3 for standard work, 4-5 for complex architectural changes.

${(() => {
  const n = context?.previousTrajectories ? 11 : 10;
  const ambition = context?.ambitionLevel ?? 'moderate';
  const firstStepDirective = ambition === 'conservative'
    ? `**CRITICAL — First step must be trivially safe:** Step 1 MUST touch exactly 1 file, have zero dependencies, and be a guaranteed success (e.g., add a missing type annotation, fix an obvious lint error). The system has low recent completion rates — establish a win before anything else.`
    : ambition === 'ambitious'
    ? `**First step — moderate complexity allowed:** Recent completion rates are strong. Step 1 can tackle a real problem (3-5 files, moderate complexity), but keep it self-contained with zero dependencies on other steps. Save the most complex work for later steps.`
    : `**CRITICAL — First step must be a "gimme":** Step 1 MUST be the simplest, most self-contained change (1-3 files, zero deps, single-cycle completable). Complex work belongs in steps 2+.`;
  const stratificationDirective = `**Complexity gradient across steps:** Structure the trajectory as an escalating difficulty curve:
   - Step 1: ${ambition === 'conservative' ? 'Trivial (1 file, guaranteed win)' : ambition === 'ambitious' ? 'Moderate (real problem, self-contained)' : 'Simple (1-3 files, quick win)'}
   - Step 2: Moderate complexity — builds on step 1, can touch 3-5 files
   - Steps 3+: Full complexity allowed — multi-file refactors, architectural changes
   - Final step: Consolidation — tests for new code, cleanup, or verification
   Each step should be harder than the previous. Never front-load the hardest work.
   For short trajectories (2-3 steps): step 1 stays as described above, remaining steps can be moderate-to-full complexity. The consolidation role merges into the final step.`;
  return `${n}. ${firstStepDirective}\n\n${n + 1}. ${stratificationDirective}`;
})()}

${context?.previousTrajectories ? '13' : '12'}. **Scope from file paths:** Each proposal lists its relevant files. Compute step scopes from those file paths — use the common parent directory + glob (e.g., if files are "src/auth/login.ts" and "src/auth/session.ts", scope should be "src/auth/**"). Do NOT guess scopes.

## Anti-Patterns to Avoid

- Don't scope steps too broadly (e.g., "src/**"). Use specific paths like "src/auth/**" or "packages/core/src/*.ts".
- Avoid unnecessary dependency chains where every step depends on the previous. Use parallelizable structure when steps are independent.
- Verification commands MUST be stable and deterministic:
  - Use "npm test", "npx vitest run", "npx tsc --noEmit" — NOT hardcoded line numbers or fragile string matching
  - Do NOT reference specific test files unless they already exist in the codebase
  - Prefer running the full test suite or type checker over narrow assertions
- Don't create too many tiny steps — merge closely related work into one step.

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation):

{
  "name": "drill-kebab-case-name",
  "description": "One-line description of the trajectory theme",
  "steps": [
    {
      "id": "step-id",
      "title": "Short imperative title",
      "description": "What this step accomplishes and how",
      "scope": "glob/pattern/**",
      "categories": ["refactor"],
      "acceptance_criteria": ["Criterion that can be checked"],
      "verification_commands": ["command that exits 0 on success"],
      "depends_on": [],
      "priority": 7,
      "max_retries": 3
    }
  ]
}`);

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Verification command sanitization
// ---------------------------------------------------------------------------

/**
 * Remove empty, nonsensical, or fragile verification commands.
 * Catches common LLM generation issues:
 * - Empty or whitespace-only commands
 * - Pure punctuation/numbers (not real commands)
 * - Commands with hardcoded line numbers (break on any code change)
 */
export function sanitizeVerificationCommands(commands: string[]): string[] {
  return commands.filter(cmd => {
    const trimmed = cmd.trim();
    if (!trimmed) return false;
    // Reject pure punctuation/numbers — not a real command
    if (/^[^a-zA-Z]+$/.test(trimmed)) return false;
    // Reject commands with hardcoded line numbers (fragile — break on any edit)
    // Matches patterns like: grep -n "foo" file.ts:42, --line 15, :123
    if (/:\d+\s*$/.test(trimmed)) return false;
    if (/--line\s+\d+/.test(trimmed)) return false;
    // Reject commands that are just "true" or "false" — not a meaningful check
    if (trimmed === 'true' || trimmed === 'false') return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface RawStep {
  id?: string;
  title?: string;
  description?: string;
  scope?: string;
  categories?: string[];
  acceptance_criteria?: string[];
  verification_commands?: string[];
  depends_on?: string[];
  measure?: { cmd?: string; target?: number; direction?: string };
  max_retries?: number;
  priority?: number;
}

export function validateAndBuild(raw: { name: string; description: string; steps: unknown[] }): Trajectory {
  const steps: TrajectoryStep[] = (raw.steps as RawStep[]).map((s) => ({
    id: String(s.id || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
    title: String(s.title || ''),
    description: String(s.description || ''),
    scope: s.scope ? String(s.scope) : undefined,
    categories: Array.isArray(s.categories) ? s.categories.map(String) : undefined,
    acceptance_criteria: Array.isArray(s.acceptance_criteria) ? s.acceptance_criteria.map(String) : [],
    verification_commands: sanitizeVerificationCommands(Array.isArray(s.verification_commands) ? s.verification_commands.map(String) : []),
    depends_on: Array.isArray(s.depends_on) ? s.depends_on.map(String) : [],
    max_retries: typeof s.max_retries === 'number' && s.max_retries > 0 ? s.max_retries : undefined,
    priority: typeof s.priority === 'number' && s.priority >= 1 && s.priority <= 10 ? s.priority : undefined,
    measure: (() => {
      if (!s.measure?.cmd || s.measure?.target === undefined || !s.measure?.direction) return undefined;
      const parsedTarget = Number(s.measure.target);
      if (isNaN(parsedTarget)) return undefined; // reject unparseable measure targets
      return {
        cmd: String(s.measure.cmd),
        target: parsedTarget,
        direction: s.measure.direction === 'down' ? 'down' as const : 'up' as const,
      };
    })(),
  }));

  // Validate: must have at least one step
  if (steps.length === 0) throw new Error('Trajectory has no steps');

  // Validate: no duplicate IDs
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id) throw new Error('Step missing ID');
    if (!step.title) throw new Error(`Step "${step.id}" missing title`);
    if (ids.has(step.id)) throw new Error(`Duplicate step ID: ${step.id}`);
    ids.add(step.id);
  }

  // Validate: depends_on references exist
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (!ids.has(dep)) throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`);
    }
  }

  // Validate: no circular dependencies
  const cycle = detectCycle(steps);
  if (cycle) throw new Error(`Circular dependency detected: ${cycle.join(' → ')}`);

  // Validate: step scopes should not be overly broad (top-level wildcards)
  const OVERLY_BROAD_SCOPES = ['**', '*', '.', './**'];
  for (const step of steps) {
    if (step.scope && OVERLY_BROAD_SCOPES.includes(step.scope)) {
      // Sanitize to a more reasonable scope — don't reject, just clear
      step.scope = undefined; // let the session scope handle it
    }
  }

  return {
    name: String(raw.name || ''),
    description: String(raw.description || ''),
    steps,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // For drill names with timestamp suffix (drill-<name>-<13-digit-ts>),
  // ensure the timestamp is always preserved by capping the name portion
  const timestampMatch = slug.match(/-(\d{13})$/);
  if (timestampMatch) {
    const namepart = slug.slice(0, slug.length - 14); // everything before -<timestamp>
    return namepart.slice(0, 66) + '-' + timestampMatch[1]; // 66 + 1 + 13 = 80 max
  }

  return slug.slice(0, 80);
}
