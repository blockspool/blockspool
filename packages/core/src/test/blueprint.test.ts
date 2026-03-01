/**
 * Tests for proposals/blueprint.ts — pure-function proposal analysis.
 */

import { describe, it, expect } from 'vitest';
import {
  groupByFileOverlap,
  detectConflicts,
  identifyEnablers,
  detectMergeablePairs,
  computeBlueprint,
  formatBlueprintForPrompt,
  type ProposalInput,
} from '../proposals/blueprint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<ProposalInput> & { files: string[] }): ProposalInput {
  return {
    title: 'Test proposal',
    category: 'refactor',
    confidence: 80,
    impact_score: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// groupByFileOverlap
// ---------------------------------------------------------------------------

describe('groupByFileOverlap', () => {
  it('groups proposals with high file overlap into one group', () => {
    // Jaccard: intersection(2)/union(3) = 0.67 >= 0.5
    const proposals = [
      makeProposal({ title: 'A', files: ['src/auth/login.ts', 'src/auth/session.ts'] }),
      makeProposal({ title: 'B', files: ['src/auth/login.ts', 'src/auth/session.ts', 'src/auth/utils.ts'] }),
    ];

    const groups = groupByFileOverlap(proposals);
    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIndices).toEqual(expect.arrayContaining([0, 1]));
  });

  it('separates proposals with disjoint file sets', () => {
    const proposals = [
      makeProposal({ title: 'A', files: ['src/auth/login.ts'] }),
      makeProposal({ title: 'B', files: ['src/db/connect.ts'] }),
    ];

    const groups = groupByFileOverlap(proposals);
    expect(groups).toHaveLength(2);
  });

  it('computes common scope for grouped proposals', () => {
    // Jaccard: intersection(2)/union(3) = 0.67 >= 0.5
    const proposals = [
      makeProposal({ title: 'A', files: ['src/auth/login.ts', 'src/auth/session.ts'] }),
      makeProposal({ title: 'B', files: ['src/auth/login.ts', 'src/auth/session.ts', 'src/auth/middleware.ts'] }),
    ];

    const groups = groupByFileOverlap(proposals);
    expect(groups).toHaveLength(1);
    expect(groups[0].commonScope).toBe('src/auth/**');
  });

  it('handles single proposal', () => {
    const proposals = [
      makeProposal({ title: 'A', files: ['src/foo.ts'] }),
    ];

    const groups = groupByFileOverlap(proposals);
    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIndices).toEqual([0]);
  });

  it('handles empty proposals', () => {
    const groups = groupByFileOverlap([]);
    expect(groups).toHaveLength(0);
  });

  it('uses union-find for transitive grouping (A overlaps B, B overlaps C)', () => {
    // A and B share shared.ts (Jaccard 1/2 = 0.5, meets threshold)
    // B and C share b.ts (Jaccard 1/2 = 0.5, meets threshold)
    // Transitive: A, B, C should all be in one group
    const proposals = [
      makeProposal({ title: 'A', files: ['src/shared.ts'] }),
      makeProposal({ title: 'B', files: ['src/shared.ts', 'src/b.ts'] }),
      makeProposal({ title: 'C', files: ['src/b.ts'] }),
    ];

    const groups = groupByFileOverlap(proposals);
    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIndices).toHaveLength(3);
  });

  it('combines theme from multiple categories', () => {
    // Jaccard: intersection(1)/union(1) = 1.0 >= 0.5
    const proposals = [
      makeProposal({ title: 'A', category: 'refactor', files: ['src/shared.ts'] }),
      makeProposal({ title: 'B', category: 'test', files: ['src/shared.ts'] }),
    ];

    const groups = groupByFileOverlap(proposals);
    expect(groups).toHaveLength(1);
    expect(groups[0].theme).toContain('refactor');
    expect(groups[0].theme).toContain('test');
  });
});

// ---------------------------------------------------------------------------
// detectConflicts
// ---------------------------------------------------------------------------

describe('detectConflicts', () => {
  it('detects conflict when proposals touch same file with different categories', () => {
    const proposals = [
      makeProposal({ title: 'A', category: 'refactor', files: ['src/auth.ts'] }),
      makeProposal({ title: 'B', category: 'security', files: ['src/auth.ts'] }),
    ];

    const conflicts = detectConflicts(proposals);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].indexA).toBe(0);
    expect(conflicts[0].indexB).toBe(1);
    expect(conflicts[0].reason).toContain('src/auth.ts');
    expect(conflicts[0].reason).toContain('refactor');
    expect(conflicts[0].reason).toContain('security');
  });

  it('no conflict when proposals have the same category', () => {
    const proposals = [
      makeProposal({ title: 'A', category: 'refactor', files: ['src/auth.ts'] }),
      makeProposal({ title: 'B', category: 'refactor', files: ['src/auth.ts'] }),
    ];

    const conflicts = detectConflicts(proposals);
    expect(conflicts).toHaveLength(0);
  });

  it('no conflict when proposals touch different files', () => {
    const proposals = [
      makeProposal({ title: 'A', category: 'refactor', files: ['src/auth.ts'] }),
      makeProposal({ title: 'B', category: 'security', files: ['src/db.ts'] }),
    ];

    const conflicts = detectConflicts(proposals);
    expect(conflicts).toHaveLength(0);
  });

  it('resolves as keep_higher_impact when score difference is large', () => {
    const proposals = [
      makeProposal({ title: 'A', category: 'refactor', files: ['src/auth.ts'], impact_score: 8, confidence: 90 }),
      makeProposal({ title: 'B', category: 'security', files: ['src/auth.ts'], impact_score: 3, confidence: 50 }),
    ];

    const conflicts = detectConflicts(proposals);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resolution).toBe('keep_higher_impact');
  });

  it('resolves as sequence when scores are close', () => {
    const proposals = [
      makeProposal({ title: 'A', category: 'refactor', files: ['src/auth.ts'], impact_score: 5, confidence: 80 }),
      makeProposal({ title: 'B', category: 'security', files: ['src/auth.ts'], impact_score: 5, confidence: 70 }),
    ];

    const conflicts = detectConflicts(proposals);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resolution).toBe('sequence');
  });
});

// ---------------------------------------------------------------------------
// identifyEnablers
// ---------------------------------------------------------------------------

describe('identifyEnablers', () => {
  it('identifies enabler when proposal module is imported by another', () => {
    const proposals = [
      makeProposal({ title: 'Core fix', files: ['src/core/index.ts'] }),
      makeProposal({ title: 'Auth fix', files: ['src/auth/login.ts'] }),
    ];
    const depEdges = {
      'src/auth': ['src/core'], // auth imports core
    };

    const enablers = identifyEnablers(proposals, depEdges);
    expect(enablers).toContain(0); // core is an enabler
  });

  it('returns empty when no dependency edges', () => {
    const proposals = [
      makeProposal({ title: 'A', files: ['src/a.ts'] }),
    ];

    const enablers = identifyEnablers(proposals, {});
    expect(enablers).toHaveLength(0);
  });

  it('returns empty when proposals are independent', () => {
    const proposals = [
      makeProposal({ title: 'A', files: ['src/a/index.ts'] }),
      makeProposal({ title: 'B', files: ['src/b/index.ts'] }),
    ];
    const depEdges = {
      'src/c': ['src/d'],
    };

    const enablers = identifyEnablers(proposals, depEdges);
    expect(enablers).toHaveLength(0);
  });

  it('deduplicates enabler indices', () => {
    const proposals = [
      makeProposal({ title: 'Core fix', files: ['src/core/a.ts', 'src/core/b.ts'] }),
      makeProposal({ title: 'Auth fix', files: ['src/auth/login.ts'] }),
      makeProposal({ title: 'API fix', files: ['src/api/routes.ts'] }),
    ];
    const depEdges = {
      'src/auth': ['src/core'],
      'src/api': ['src/core'],
    };

    const enablers = identifyEnablers(proposals, depEdges);
    // core enables both auth and api, but should appear only once
    expect(enablers.filter(i => i === 0)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectMergeablePairs
// ---------------------------------------------------------------------------

describe('detectMergeablePairs', () => {
  it('detects mergeable pair with high overlap and same category', () => {
    const proposals = [
      makeProposal({ title: 'Fix A', category: 'fix', files: ['src/auth.ts', 'src/session.ts', 'src/utils.ts'] }),
      makeProposal({ title: 'Fix B', category: 'fix', files: ['src/auth.ts', 'src/session.ts', 'src/helpers.ts'] }),
    ];

    const pairs = detectMergeablePairs(proposals);
    // Jaccard: intersection(2)/union(4) = 0.5 — below 0.7 threshold
    expect(pairs).toHaveLength(0);
  });

  it('detects mergeable pair with >=70% overlap', () => {
    const proposals = [
      makeProposal({ title: 'Fix A', category: 'fix', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
      makeProposal({ title: 'Fix B', category: 'fix', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
    ];

    const pairs = detectMergeablePairs(proposals);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual([0, 1]);
  });

  it('skips pairs with different categories', () => {
    const proposals = [
      makeProposal({ title: 'Fix A', category: 'fix', files: ['src/a.ts'] }),
      makeProposal({ title: 'Refactor A', category: 'refactor', files: ['src/a.ts'] }),
    ];

    const pairs = detectMergeablePairs(proposals);
    expect(pairs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeBlueprint
// ---------------------------------------------------------------------------

describe('computeBlueprint', () => {
  it('produces a complete blueprint with realistic proposals', () => {
    const proposals = [
      makeProposal({ title: 'Fix auth types', category: 'types', files: ['src/auth/types.ts', 'src/auth/login.ts'], impact_score: 7, confidence: 90 }),
      makeProposal({ title: 'Fix auth session', category: 'types', files: ['src/auth/types.ts', 'src/auth/session.ts'], impact_score: 6, confidence: 85 }),
      makeProposal({ title: 'Add DB tests', category: 'test', files: ['src/db/connect.ts'], impact_score: 5, confidence: 80 }),
      makeProposal({ title: 'Refactor DB', category: 'refactor', files: ['src/db/connect.ts'], impact_score: 4, confidence: 70 }),
    ];
    const depEdges = {
      'src/auth': ['src/db'],
    };

    const blueprint = computeBlueprint(proposals, depEdges);

    // Should have groups, conflicts, enablers
    expect(blueprint.groups.length).toBeGreaterThan(0);
    expect(blueprint.executionArc).toBeTruthy();

    // DB should be identified as enabler (auth depends on it)
    // Proposals 2 and 3 touch src/db — one of them should be enabler
    expect(blueprint.enablers.length).toBeGreaterThan(0);
  });

  it('reorders groups so enablers come first', () => {
    const proposals = [
      makeProposal({ title: 'UI fix', files: ['src/ui/button.ts'] }),
      makeProposal({ title: 'Core fix', files: ['src/core/utils.ts'] }),
    ];
    const depEdges = {
      'src/ui': ['src/core'],
    };

    const blueprint = computeBlueprint(proposals, depEdges);

    // Find the group containing the core fix (enabler)
    const enablerGroup = blueprint.groups.find(g => g.isEnabler);
    const nonEnablerGroup = blueprint.groups.find(g => !g.isEnabler);

    if (enablerGroup && nonEnablerGroup) {
      expect(enablerGroup.suggestedOrder).toBeLessThan(nonEnablerGroup.suggestedOrder);
    }
  });
});

// ---------------------------------------------------------------------------
// formatBlueprintForPrompt
// ---------------------------------------------------------------------------

describe('formatBlueprintForPrompt', () => {
  it('formats a complete blueprint as readable text', () => {
    const proposals = [
      makeProposal({ title: 'Fix auth', category: 'fix', files: ['src/auth/login.ts'] }),
      makeProposal({ title: 'Add tests', category: 'test', files: ['src/db/test.ts'] }),
    ];
    const blueprint = computeBlueprint(proposals);
    const text = formatBlueprintForPrompt(blueprint, proposals);

    expect(text).toContain('Arc:');
    expect(text).toContain('Groups:');
    expect(text).toContain('Fix auth');
    expect(text).toContain('Add tests');
  });

  it('includes conflict section when conflicts exist', () => {
    const proposals = [
      makeProposal({ title: 'Refactor auth', category: 'refactor', files: ['src/auth.ts'] }),
      makeProposal({ title: 'Secure auth', category: 'security', files: ['src/auth.ts'] }),
    ];
    const blueprint = computeBlueprint(proposals);
    const text = formatBlueprintForPrompt(blueprint, proposals);

    expect(text).toContain('Conflicts:');
  });

  it('includes mergeable section when near-duplicates exist', () => {
    const proposals = [
      makeProposal({ title: 'Fix A', category: 'fix', files: ['src/a.ts', 'src/b.ts'] }),
      makeProposal({ title: 'Fix B', category: 'fix', files: ['src/a.ts', 'src/b.ts'] }),
    ];
    const blueprint = computeBlueprint(proposals);
    const text = formatBlueprintForPrompt(blueprint, proposals);

    expect(text).toContain('Mergeable');
  });

  it('marks enabler groups', () => {
    const proposals = [
      makeProposal({ title: 'Core fix', files: ['src/core/utils.ts'] }),
      makeProposal({ title: 'UI fix', files: ['src/ui/button.ts'] }),
    ];
    const depEdges = { 'src/ui': ['src/core'] };
    const blueprint = computeBlueprint(proposals, depEdges);
    const text = formatBlueprintForPrompt(blueprint, proposals);

    expect(text).toContain('ENABLER');
  });
});

// ---------------------------------------------------------------------------
// Configurable thresholds
// ---------------------------------------------------------------------------

describe('groupByFileOverlap — custom threshold', () => {
  it('groups more aggressively with a lower threshold', () => {
    // Jaccard: intersection(1)/union(3) ≈ 0.33 — below default 0.5 but above 0.3
    const proposals = [
      makeProposal({ title: 'A', files: ['src/a.ts', 'src/b.ts'] }),
      makeProposal({ title: 'B', files: ['src/a.ts', 'src/c.ts'] }),
    ];

    const defaultGroups = groupByFileOverlap(proposals);
    expect(defaultGroups).toHaveLength(2); // not merged at 0.5

    const aggressiveGroups = groupByFileOverlap(proposals, 0.3);
    expect(aggressiveGroups).toHaveLength(1); // merged at 0.3
  });

  it('groups less aggressively with a higher threshold', () => {
    // Jaccard: intersection(2)/union(3) ≈ 0.67 — above 0.5 but below 0.8
    const proposals = [
      makeProposal({ title: 'A', files: ['src/a.ts', 'src/b.ts'] }),
      makeProposal({ title: 'B', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
    ];

    const defaultGroups = groupByFileOverlap(proposals);
    expect(defaultGroups).toHaveLength(1); // merged at 0.5

    const strictGroups = groupByFileOverlap(proposals, 0.8);
    expect(strictGroups).toHaveLength(2); // not merged at 0.8
  });
});

describe('detectMergeablePairs — custom threshold', () => {
  it('detects more mergeable pairs with a lower threshold', () => {
    // Same category, Jaccard = 2/3 ≈ 0.67 — below default 0.7 but above 0.5
    const proposals = [
      makeProposal({ title: 'Fix A', category: 'fix', files: ['src/a.ts', 'src/b.ts'] }),
      makeProposal({ title: 'Fix B', category: 'fix', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
    ];

    const defaultPairs = detectMergeablePairs(proposals);
    expect(defaultPairs).toHaveLength(0); // not merged at 0.7

    const loosePairs = detectMergeablePairs(proposals, 0.5);
    expect(loosePairs).toHaveLength(1); // merged at 0.5
  });
});

describe('computeBlueprint — config passthrough', () => {
  it('passes custom thresholds to grouping and merging', () => {
    // Two proposals with same category and 67% overlap
    const proposals = [
      makeProposal({ title: 'Fix A', category: 'fix', files: ['src/a.ts', 'src/b.ts'] }),
      makeProposal({ title: 'Fix B', category: 'fix', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
    ];

    const defaultBlueprint = computeBlueprint(proposals);
    // Default: grouped (67% > 50%), not mergeable (67% < 70%)
    expect(defaultBlueprint.groups).toHaveLength(1);
    expect(defaultBlueprint.mergeablePairs).toHaveLength(0);

    const looseBlueprint = computeBlueprint(proposals, {}, {
      groupOverlapThreshold: 0.3,
      mergeableOverlapThreshold: 0.5,
    });
    expect(looseBlueprint.groups).toHaveLength(1); // still grouped
    expect(looseBlueprint.mergeablePairs).toHaveLength(1); // now mergeable
  });
});
