/**
 * Tests for proposals/trajectory-critic.ts — trajectory quality gate.
 */

import { describe, it, expect } from 'vitest';
import {
  validateTrajectoryQuality,
  formatCritique,
  type TrajectoryStepInput,
} from '../proposals/trajectory-critic.js';
import type { ProposalBlueprint, ProposalInput } from '../proposals/blueprint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<TrajectoryStepInput> & { id: string }): TrajectoryStepInput {
  return {
    scope: 'src/**',
    categories: ['refactor'],
    verification_commands: ['npm test'],
    depends_on: [],
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ProposalInput> & { files: string[] }): ProposalInput {
  return {
    title: 'Test proposal',
    category: 'refactor',
    confidence: 80,
    impact_score: 5,
    ...overrides,
  };
}

function emptyBlueprint(): ProposalBlueprint {
  return {
    groups: [],
    conflicts: [],
    enablers: [],
    mergeablePairs: [],
    executionArc: '0 group(s) total',
  };
}

// ---------------------------------------------------------------------------
// Step 1 scope breadth
// ---------------------------------------------------------------------------

describe('validateTrajectoryQuality — step 1 breadth', () => {
  it('fails when step 1 scope is broader than proposal common scope for conservative ambition', () => {
    const steps = [
      makeStep({ id: 'step-1', scope: 'src/**' }),
      makeStep({ id: 'step-2', scope: 'src/auth/**' }),
    ];
    const proposals = [
      makeProposal({ files: ['src/auth/login.ts', 'src/auth/session.ts'] }),
    ];

    const result = validateTrajectoryQuality(steps, proposals, emptyBlueprint(), 'conservative');
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes('Step 1 scope'))).toBe(true);
  });

  it('passes when step 1 scope matches proposal scope for conservative', () => {
    const steps = [
      makeStep({ id: 'step-1', scope: 'src/auth/**' }),
    ];
    const proposals = [
      makeProposal({ files: ['src/auth/login.ts'] }),
    ];

    const result = validateTrajectoryQuality(steps, proposals, emptyBlueprint(), 'conservative');
    expect(result.issues.filter(i => i.includes('Step 1 scope'))).toHaveLength(0);
  });

  it('skips breadth check for ambitious ambition', () => {
    const steps = [
      makeStep({ id: 'step-1', scope: 'src/**' }),
    ];
    const proposals = [
      makeProposal({ files: ['src/auth/login.ts'] }),
    ];

    const result = validateTrajectoryQuality(steps, proposals, emptyBlueprint(), 'ambitious');
    expect(result.issues.filter(i => i.includes('Step 1 scope'))).toHaveLength(0);
  });

  it('passes when step 1 has no scope', () => {
    const steps = [
      makeStep({ id: 'step-1', scope: undefined }),
    ];
    const proposals = [
      makeProposal({ files: ['src/auth/login.ts'] }),
    ];

    const result = validateTrajectoryQuality(steps, proposals, emptyBlueprint(), 'conservative');
    expect(result.issues.filter(i => i.includes('Step 1 scope'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Verification commands
// ---------------------------------------------------------------------------

describe('validateTrajectoryQuality — verification commands', () => {
  it('fails when a step has no verification commands', () => {
    const steps = [
      makeStep({ id: 'step-1', verification_commands: [] }),
      makeStep({ id: 'step-2', verification_commands: ['npm test'] }),
    ];

    const result = validateTrajectoryQuality(steps, [], emptyBlueprint());
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes('step-1') && i.includes('no verification'))).toBe(true);
  });

  it('passes when all steps have verification commands', () => {
    const steps = [
      makeStep({ id: 'step-1', verification_commands: ['npm test'] }),
      makeStep({ id: 'step-2', verification_commands: ['npm run typecheck'] }),
    ];

    const result = validateTrajectoryQuality(steps, [], emptyBlueprint());
    expect(result.issues.filter(i => i.includes('no verification'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step count vs ambition
// ---------------------------------------------------------------------------

describe('validateTrajectoryQuality — step count vs ambition', () => {
  it('fails when too few steps for conservative (needs 2-3)', () => {
    const steps = [makeStep({ id: 'step-1' })];

    const result = validateTrajectoryQuality(steps, [], emptyBlueprint(), 'conservative');
    expect(result.issues.some(i => i.includes('Too few steps'))).toBe(true);
  });

  it('passes with 2 steps for conservative', () => {
    const steps = [
      makeStep({ id: 'step-1' }),
      makeStep({ id: 'step-2' }),
    ];

    const result = validateTrajectoryQuality(steps, [], emptyBlueprint(), 'conservative');
    expect(result.issues.filter(i => i.includes('Too few') || i.includes('Too many'))).toHaveLength(0);
  });

  it('fails when too many steps for conservative (max 3 + 2 slack = 5)', () => {
    const steps = Array.from({ length: 6 }, (_, i) => makeStep({ id: `step-${i + 1}` }));

    const result = validateTrajectoryQuality(steps, [], emptyBlueprint(), 'conservative');
    expect(result.issues.some(i => i.includes('Too many steps'))).toBe(true);
  });

  it('passes within moderate range (3-5)', () => {
    const steps = Array.from({ length: 4 }, (_, i) => makeStep({ id: `step-${i + 1}` }));

    const result = validateTrajectoryQuality(steps, [], emptyBlueprint(), 'moderate');
    expect(result.issues.filter(i => i.includes('Too few') || i.includes('Too many'))).toHaveLength(0);
  });

  it('passes within ambitious range (5-8)', () => {
    const steps = Array.from({ length: 6 }, (_, i) => makeStep({ id: `step-${i + 1}` }));

    const result = validateTrajectoryQuality(steps, [], emptyBlueprint(), 'ambitious');
    expect(result.issues.filter(i => i.includes('Too few') || i.includes('Too many'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conflict isolation
// ---------------------------------------------------------------------------

describe('validateTrajectoryQuality — conflict isolation', () => {
  it('flags steps with too many categories', () => {
    const steps = [
      makeStep({ id: 'step-1', categories: ['refactor', 'fix', 'security', 'types'] }),
      makeStep({ id: 'step-2', categories: ['test'] }),
    ];
    const blueprint: ProposalBlueprint = {
      ...emptyBlueprint(),
      conflicts: [{ indexA: 0, indexB: 1, reason: 'test', resolution: 'keep_higher_impact' }],
    };

    const result = validateTrajectoryQuality(steps, [], blueprint);
    expect(result.issues.some(i => i.includes('step-1') && i.includes('categories'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatCritique
// ---------------------------------------------------------------------------

describe('formatCritique', () => {
  it('formats issues as trajectory-critique XML block', () => {
    const critique = formatCritique(['Issue one', 'Issue two']);

    expect(critique).toContain('<trajectory-critique>');
    expect(critique).toContain('</trajectory-critique>');
    expect(critique).toContain('- Issue one');
    expect(critique).toContain('- Issue two');
    expect(critique).toContain('Quality Gate Failed');
  });

  it('returns empty string for no issues', () => {
    expect(formatCritique([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Full quality gate pass
// ---------------------------------------------------------------------------

describe('validateTrajectoryQuality — passing trajectory', () => {
  it('passes a well-structured trajectory', () => {
    const steps = [
      makeStep({ id: 'step-1', scope: 'src/auth/**', categories: ['types'], verification_commands: ['npm run typecheck'] }),
      makeStep({ id: 'step-2', scope: 'src/auth/**', categories: ['refactor'], verification_commands: ['npm test'], depends_on: ['step-1'] }),
      makeStep({ id: 'step-3', scope: 'src/auth/**', categories: ['test'], verification_commands: ['npm test'], depends_on: ['step-2'] }),
    ];
    const proposals = [
      makeProposal({ files: ['src/auth/login.ts', 'src/auth/session.ts'] }),
      makeProposal({ files: ['src/auth/utils.ts'] }),
    ];

    const result = validateTrajectoryQuality(steps, proposals, emptyBlueprint(), 'moderate');
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.critique).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Custom stepCountSlack
// ---------------------------------------------------------------------------

describe('validateTrajectoryQuality — custom stepCountSlack', () => {
  it('fails with stepCountSlack=0 when steps exceed range', () => {
    // Conservative range is [2, 3]. With slack=0, 4 steps should fail.
    const steps = Array.from({ length: 4 }, (_, i) => makeStep({ id: `step-${i + 1}` }));

    const result = validateTrajectoryQuality(steps, [], emptyBlueprint(), 'conservative', { stepCountSlack: 0 });
    expect(result.issues.some(i => i.includes('Too many steps'))).toBe(true);
  });

  it('passes with higher stepCountSlack', () => {
    // Conservative range is [2, 3]. With slack=5, 8 steps should pass.
    const steps = Array.from({ length: 8 }, (_, i) => makeStep({ id: `step-${i + 1}` }));

    const result = validateTrajectoryQuality(steps, [], emptyBlueprint(), 'conservative', { stepCountSlack: 5 });
    expect(result.issues.filter(i => i.includes('Too many steps'))).toHaveLength(0);
  });

  it('uses default slack=2 when config not provided', () => {
    // Conservative range [2, 3] + default slack 2 = max 5. 6 steps should fail.
    const steps = Array.from({ length: 6 }, (_, i) => makeStep({ id: `step-${i + 1}` }));

    const withDefault = validateTrajectoryQuality(steps, [], emptyBlueprint(), 'conservative');
    expect(withDefault.issues.some(i => i.includes('Too many steps'))).toBe(true);

    // 5 steps should pass (3 + 2 = 5)
    const fiveSteps = Array.from({ length: 5 }, (_, i) => makeStep({ id: `step-${i + 1}` }));
    const withFive = validateTrajectoryQuality(fiveSteps, [], emptyBlueprint(), 'conservative');
    expect(withFive.issues.filter(i => i.includes('Too many steps'))).toHaveLength(0);
  });
});
