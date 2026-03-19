/**
 * Proposals algorithm tests — covers pure functions in proposals/shared.ts:
 *   - validateProposalSchema
 *   - normalizeProposal
 *   - buildProposalReviewPrompt
 *   - parseReviewedProposals
 *   - applyReviewToProposals
 *   - scoreAndRank
 *   - balanceProposals
 *   - formatProposalDescription
 *   - computePriority
 *   - PROPOSALS_DEFAULTS
 *
 * Tests pure functions only (no filesystem, no database).
 */

import { describe, it, expect } from 'vitest';
import {
  type RawProposal,
  type ValidatedProposal,
  type ReviewedProposal,
  type GraphContext,
  type ProposalSeverity,
  validateProposalSchema,
  normalizeProposal,
  buildProposalReviewPrompt,
  parseReviewedProposals,
  applyReviewToProposals,
  scoreAndRank,
  computeGraphBoost,
  balanceProposals,
  formatProposalDescription,
  computePriority,
  PROPOSALS_DEFAULTS,
  SEVERITY_WEIGHT,
  inferSeverity,
} from '../proposals/shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRaw(overrides: Partial<RawProposal> = {}): RawProposal {
  return {
    category: 'refactor',
    title: 'Extract shared validation logic',
    description: 'Three handlers duplicate email validation',
    acceptance_criteria: ['Single validateEmail() function'],
    verification_commands: ['npm test'],
    allowed_paths: ['src/handlers/', 'src/utils/'],
    files: ['src/handlers/signup.ts', 'src/utils/validate.ts'],
    confidence: 85,
    impact_score: 7,
    rationale: 'Reduces duplication',
    estimated_complexity: 'simple',
    risk: 'low',
    touched_files_estimate: 3,
    rollback_note: 'Revert single commit',
    ...overrides,
  };
}

function makeValidated(overrides: Partial<ValidatedProposal> = {}): ValidatedProposal {
  return {
    category: 'refactor',
    title: 'Extract shared validation logic',
    description: 'Three handlers duplicate email validation',
    acceptance_criteria: ['Single validateEmail() function'],
    verification_commands: ['npm test'],
    allowed_paths: ['src/handlers/', 'src/utils/'],
    files: ['src/handlers/signup.ts', 'src/utils/validate.ts'],
    confidence: 85,
    impact_score: 7,
    rationale: 'Reduces duplication',
    estimated_complexity: 'simple',
    risk: 'low',
    touched_files_estimate: 3,
    rollback_note: 'Revert single commit',
    severity: 'polish',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PROPOSALS_DEFAULTS
// ---------------------------------------------------------------------------

describe('PROPOSALS_DEFAULTS', () => {
  it('has expected default values', () => {
    expect(PROPOSALS_DEFAULTS.MAX_DEFERRED).toBe(20);
    expect(PROPOSALS_DEFAULTS.MAX_TEST_RATIO).toBe(0.4);
    expect(PROPOSALS_DEFAULTS.DEFAULT_IMPACT).toBe(5);
    expect(PROPOSALS_DEFAULTS.MIN_CONFIDENCE).toBe(1);
    expect(PROPOSALS_DEFAULTS.DEFAULT_MIN_IMPACT).toBe(5);
    expect(PROPOSALS_DEFAULTS.DEDUP_THRESHOLD).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// validateProposalSchema
// ---------------------------------------------------------------------------

describe('validateProposalSchema', () => {
  it('returns null for valid proposal', () => {
    expect(validateProposalSchema(makeRaw())).toBeNull();
  });

  it('reports missing title', () => {
    const result = validateProposalSchema(makeRaw({ title: undefined }));
    expect(result).toContain('title');
  });

  it('reports missing category', () => {
    const result = validateProposalSchema(makeRaw({ category: undefined }));
    expect(result).toContain('category');
  });

  it('coerces string confidence to number', () => {
    const raw = makeRaw({ confidence: '75' as any });
    const result = validateProposalSchema(raw);
    expect(result).toBeNull();
    expect(raw.confidence).toBe(75);
  });

  it('defaults missing confidence to 50', () => {
    const raw = makeRaw({ confidence: undefined });
    const result = validateProposalSchema(raw);
    expect(result).toBeNull();
    expect(raw.confidence).toBe(50);
  });

  it('coerces string impact_score to number', () => {
    const raw = makeRaw({ impact_score: '7' as any });
    validateProposalSchema(raw);
    expect(raw.impact_score).toBe(7);
  });

  it('coerces string touched_files_estimate to number', () => {
    const raw = makeRaw({ touched_files_estimate: '3' as any });
    validateProposalSchema(raw);
    expect(raw.touched_files_estimate).toBe(3);
  });

  it('rejects non-numeric string confidence', () => {
    const raw = makeRaw({ confidence: 'high' as any });
    const result = validateProposalSchema(raw);
    expect(result).toContain('confidence');
  });

  it('reports multiple missing fields', () => {
    const result = validateProposalSchema({ title: 'Only title' } as RawProposal);
    expect(result).toBeTruthy();
    const fields = result!.split(', ');
    // category, description, allowed_paths are missing (confidence defaults to 50)
    expect(fields.length).toBeGreaterThanOrEqual(3);
  });

  it('validates array fields when present', () => {
    const result = validateProposalSchema(makeRaw({
      allowed_paths: 'not-an-array' as any,
      files: 'not-an-array' as any,
    }));
    expect(result).toContain('allowed_paths');
    expect(result).toContain('files');
  });

  it('accepts missing risk (soft-required, defaults in normalize)', () => {
    const result = validateProposalSchema(makeRaw({ risk: undefined }));
    expect(result).toBeNull();
  });

  it('rejects wrong-type risk', () => {
    const result = validateProposalSchema(makeRaw({ risk: 123 as any }));
    expect(result).toContain('risk');
  });

  it('accepts missing touched_files_estimate (soft-required, defaults in normalize)', () => {
    const result = validateProposalSchema(makeRaw({ touched_files_estimate: undefined }));
    expect(result).toBeNull();
  });

  it('rejects wrong-type touched_files_estimate', () => {
    const result = validateProposalSchema(makeRaw({ touched_files_estimate: 'bad' as any }));
    expect(result).toContain('touched_files_estimate');
  });

  it('accepts missing rollback_note (soft-required, defaults in normalize)', () => {
    const result = validateProposalSchema(makeRaw({ rollback_note: undefined }));
    expect(result).toBeNull();
  });

  it('rejects wrong-type rollback_note', () => {
    const result = validateProposalSchema(makeRaw({ rollback_note: 123 as any }));
    expect(result).toContain('rollback_note');
  });
});

// ---------------------------------------------------------------------------
// normalizeProposal
// ---------------------------------------------------------------------------

describe('normalizeProposal', () => {
  it('preserves existing fields', () => {
    const result = normalizeProposal(makeRaw());
    expect(result.title).toBe('Extract shared validation logic');
    expect(result.confidence).toBe(85);
    expect(result.impact_score).toBe(7);
  });

  it('defaults impact_score to 5', () => {
    const result = normalizeProposal(makeRaw({ impact_score: undefined }));
    expect(result.impact_score).toBe(PROPOSALS_DEFAULTS.DEFAULT_IMPACT);
  });

  it('defaults estimated_complexity to moderate', () => {
    const result = normalizeProposal(makeRaw({ estimated_complexity: undefined }));
    expect(result.estimated_complexity).toBe('moderate');
  });

  it('defaults rationale to empty string', () => {
    const result = normalizeProposal(makeRaw({ rationale: undefined }));
    expect(result.rationale).toBe('');
  });

  it('defaults acceptance_criteria to empty array', () => {
    const result = normalizeProposal(makeRaw({ acceptance_criteria: undefined }));
    expect(result.acceptance_criteria).toEqual([]);
  });

  it('lowercases category', () => {
    const result = normalizeProposal(makeRaw({ category: 'Fix' }));
    expect(result.category).toBe('fix');
  });

  it('lowercases mixed-case category', () => {
    const result = normalizeProposal(makeRaw({ category: 'REFACTOR' }));
    expect(result.category).toBe('refactor');
  });

  it('clamps impact_score above 10 to 10', () => {
    const result = normalizeProposal(makeRaw({ impact_score: 15 }));
    expect(result.impact_score).toBe(10);
  });

  it('clamps impact_score below 1 to 1', () => {
    const result = normalizeProposal(makeRaw({ impact_score: -2 }));
    expect(result.impact_score).toBe(1);
  });

  it('clamps impact_score of 0 to 1', () => {
    const result = normalizeProposal(makeRaw({ impact_score: 0 }));
    expect(result.impact_score).toBe(1);
  });

  it('preserves impact_score in valid range', () => {
    const result = normalizeProposal(makeRaw({ impact_score: 7 }));
    expect(result.impact_score).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// buildProposalReviewPrompt
// ---------------------------------------------------------------------------

describe('buildProposalReviewPrompt', () => {
  it('includes all proposal titles', () => {
    const proposals = [
      makeValidated({ title: 'Fix auth bypass' }),
      makeValidated({ title: 'Add missing tests' }),
    ];
    const prompt = buildProposalReviewPrompt(proposals);
    expect(prompt).toContain('Fix auth bypass');
    expect(prompt).toContain('Add missing tests');
  });

  it('includes review instructions', () => {
    const prompt = buildProposalReviewPrompt([makeValidated()]);
    expect(prompt).toContain('Adversarial Proposal Review');
    expect(prompt).toContain('skeptical senior engineer');
    expect(prompt).toContain('confidence inflated');
    expect(prompt).toContain('Feasibility');
  });

  it('includes confidence and impact per proposal', () => {
    const prompt = buildProposalReviewPrompt([
      makeValidated({ confidence: 92, impact_score: 8 }),
    ]);
    expect(prompt).toContain('**Confidence:** 92');
    expect(prompt).toContain('**Impact:** 8/10');
  });

  it('includes files and verification', () => {
    const prompt = buildProposalReviewPrompt([
      makeValidated({
        files: ['src/a.ts', 'src/b.ts'],
        verification_commands: ['npm test', 'npm run lint'],
      }),
    ]);
    expect(prompt).toContain('src/a.ts, src/b.ts');
    expect(prompt).toContain('npm test, npm run lint');
  });

  it('handles empty files and verification', () => {
    const prompt = buildProposalReviewPrompt([
      makeValidated({ files: [], verification_commands: [] }),
    ]);
    expect(prompt).toContain('(none listed)');
    expect(prompt).toContain('(none)');
  });

  it('includes MCP ingest_event instructions', () => {
    const prompt = buildProposalReviewPrompt([makeValidated()]);
    expect(prompt).toContain('promptwheel_ingest_event');
    expect(prompt).toContain('PROPOSALS_REVIEWED');
    expect(prompt).toContain('reviewed_proposals');
  });

  it('defaults impact when not provided', () => {
    const prompt = buildProposalReviewPrompt([
      { title: 'X', category: 'fix', confidence: 80, files: [], description: 'desc' },
    ]);
    expect(prompt).toContain('**Impact:** 5/10');
  });

  it('defaults risk when not provided', () => {
    const prompt = buildProposalReviewPrompt([
      { title: 'X', category: 'fix', confidence: 80, files: [], description: 'desc' },
    ]);
    expect(prompt).toContain('(not specified)');
  });
});

// ---------------------------------------------------------------------------
// parseReviewedProposals
// ---------------------------------------------------------------------------

describe('parseReviewedProposals', () => {
  it('parses valid XML block', () => {
    const response = `
Some preamble.
<reviewed-proposals>
[
  { "title": "Fix A", "confidence": 70, "impact_score": 6, "review_note": "Adjusted" },
  { "title": "Fix B", "confidence": 0, "impact_score": 2 }
]
</reviewed-proposals>
Trailing text.
    `;
    const result = parseReviewedProposals(response);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].title).toBe('Fix A');
    expect(result![0].confidence).toBe(70);
    expect(result![0].impact_score).toBe(6);
    expect(result![0].review_note).toBe('Adjusted');
    expect(result![1].confidence).toBe(0);
    expect(result![1].review_note).toBeUndefined();
  });

  it('handles JSON wrapped in code fences', () => {
    const response = `
<reviewed-proposals>
\`\`\`json
[{ "title": "Fix A", "confidence": 80, "impact_score": 7 }]
\`\`\`
</reviewed-proposals>
    `;
    const result = parseReviewedProposals(response);
    expect(result).not.toBeNull();
    expect(result![0].confidence).toBe(80);
  });

  it('returns null when no XML block found', () => {
    expect(parseReviewedProposals('No XML here')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseReviewedProposals('<reviewed-proposals>not json</reviewed-proposals>')).toBeNull();
  });

  it('returns null for non-array JSON', () => {
    expect(parseReviewedProposals('<reviewed-proposals>{"title": "x"}</reviewed-proposals>')).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(parseReviewedProposals('<reviewed-proposals>[]</reviewed-proposals>')).toBeNull();
  });

  it('skips items without title', () => {
    const response = `
<reviewed-proposals>
[
  { "confidence": 70, "impact_score": 6 },
  { "title": "Valid", "confidence": 80, "impact_score": 7 }
]
</reviewed-proposals>
    `;
    const result = parseReviewedProposals(response);
    expect(result).toHaveLength(1);
    expect(result![0].title).toBe('Valid');
  });

  it('defaults confidence and impact for missing values', () => {
    const response = '<reviewed-proposals>[{ "title": "Fix A" }]</reviewed-proposals>';
    const result = parseReviewedProposals(response);
    expect(result).not.toBeNull();
    expect(result![0].confidence).toBe(50);
    expect(result![0].impact_score).toBe(PROPOSALS_DEFAULTS.DEFAULT_IMPACT);
  });

  it('warns when confidence or impact_score fields are missing', () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };

    try {
      const response = '<reviewed-proposals>[{ "title": "Fix A", "confidence": 80 }]</reviewed-proposals>';
      const result = parseReviewedProposals(response);
      expect(result).not.toBeNull();
      expect(result![0].confidence).toBe(80);
      expect(result![0].impact_score).toBe(PROPOSALS_DEFAULTS.DEFAULT_IMPACT);
      expect(warns.some(w => w.includes('missing') && w.includes('impact_score'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// applyReviewToProposals
// ---------------------------------------------------------------------------

describe('applyReviewToProposals', () => {
  it('applies revised scores to matching proposals', () => {
    const proposals = [
      makeValidated({ title: 'Fix A', confidence: 85, impact_score: 7 }),
      makeValidated({ title: 'Fix B', confidence: 90, impact_score: 8 }),
    ];
    const reviewed: ReviewedProposal[] = [
      { title: 'Fix A', confidence: 70, impact_score: 6 },
      { title: 'Fix B', confidence: 0, impact_score: 2 },
    ];

    const result = applyReviewToProposals(proposals, reviewed);
    expect(result[0].confidence).toBe(70);
    expect(result[0].impact_score).toBe(6);
    expect(result[1].confidence).toBe(0);
    expect(result[1].impact_score).toBe(2);
  });

  it('preserves original scores for unmatched proposals', () => {
    const proposals = [
      makeValidated({ title: 'Fix A', confidence: 85, impact_score: 7 }),
      makeValidated({ title: 'Fix C', confidence: 90, impact_score: 8 }),
    ];
    const reviewed: ReviewedProposal[] = [
      { title: 'Fix A', confidence: 70, impact_score: 6 },
    ];

    const result = applyReviewToProposals(proposals, reviewed);
    expect(result[0].confidence).toBe(70);
    expect(result[1].confidence).toBe(90);
    expect(result[1].impact_score).toBe(8);
  });

  it('matches titles case-insensitively', () => {
    const proposals = [makeValidated({ title: 'Fix Error Handling', confidence: 85 })];
    const reviewed: ReviewedProposal[] = [
      { title: 'fix error handling', confidence: 60, impact_score: 5 },
    ];

    const result = applyReviewToProposals(proposals, reviewed);
    expect(result[0].confidence).toBe(60);
  });

  it('does not mutate original proposals', () => {
    const original = makeValidated({ title: 'Fix A', confidence: 85 });
    const result = applyReviewToProposals([original], [
      { title: 'Fix A', confidence: 70, impact_score: 5 },
    ]);
    expect(original.confidence).toBe(85);
    expect(result[0].confidence).toBe(70);
  });

  it('returns empty array for empty input', () => {
    expect(applyReviewToProposals([], [])).toEqual([]);
  });

  it('works with TicketProposal-shaped objects (optional impact_score)', () => {
    const proposals = [
      { title: 'Fix X', confidence: 80, impact_score: undefined as number | undefined },
    ];
    const reviewed: ReviewedProposal[] = [
      { title: 'Fix X', confidence: 60, impact_score: 4 },
    ];

    const result = applyReviewToProposals(proposals, reviewed);
    expect(result[0].confidence).toBe(60);
    expect(result[0].impact_score).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// scoreAndRank
// ---------------------------------------------------------------------------

describe('scoreAndRank', () => {
  it('sorts by impact × confidence descending', () => {
    const proposals = [
      makeValidated({ title: 'Low', confidence: 70, impact_score: 3 }),   // 210
      makeValidated({ title: 'High', confidence: 90, impact_score: 9 }),  // 810
      makeValidated({ title: 'Mid', confidence: 80, impact_score: 5 }),   // 400
    ];

    const result = scoreAndRank(proposals);
    expect(result[0].title).toBe('High');
    expect(result[1].title).toBe('Mid');
    expect(result[2].title).toBe('Low');
  });

  it('caps at maxCount', () => {
    const proposals = Array.from({ length: 10 }, (_, i) =>
      makeValidated({ title: `P${i}`, confidence: 80, impact_score: 5 }),
    );
    const result = scoreAndRank(proposals, 3);
    expect(result).toHaveLength(3);
  });

  it('returns all when maxCount is undefined', () => {
    const proposals = Array.from({ length: 5 }, (_, i) =>
      makeValidated({ title: `P${i}`, confidence: 80, impact_score: 5 }),
    );
    const result = scoreAndRank(proposals);
    expect(result).toHaveLength(5);
  });

  it('defaults impact_score to 5 when not provided', () => {
    const proposals = [
      { confidence: 100, impact_score: undefined as number | undefined, title: 'A' },
      { confidence: 100, impact_score: 10, title: 'B' },
    ];
    const result = scoreAndRank(proposals as any);
    // B has score 1000, A has score 500
    expect((result[0] as any).title).toBe('B');
  });

  it('does not mutate input array', () => {
    const proposals = [
      makeValidated({ title: 'B', confidence: 70, impact_score: 3 }),
      makeValidated({ title: 'A', confidence: 90, impact_score: 9 }),
    ];
    const originalFirst = proposals[0].title;
    scoreAndRank(proposals);
    expect(proposals[0].title).toBe(originalFirst);
  });
});

// ---------------------------------------------------------------------------
// computeGraphBoost
// ---------------------------------------------------------------------------

describe('computeGraphBoost', () => {
  const graph: GraphContext = {
    edges: {
      'src/core': ['src/utils'],
      'src/handlers': ['src/core', 'src/utils'],
      'src/utils': [],
    },
    reverseEdges: {
      'src/core': ['src/handlers'],
      'src/utils': ['src/core', 'src/handlers', 'src/api', 'src/cli'],
    },
    hubModules: ['src/utils'],
  };

  it('returns 1.0 when no graph context', () => {
    expect(computeGraphBoost(['src/core/index.ts'], undefined)).toBe(1.0);
  });

  it('returns 1.0 when files is empty', () => {
    expect(computeGraphBoost([], graph)).toBe(1.0);
  });

  it('returns 1.0 when files do not match any graph module', () => {
    expect(computeGraphBoost(['unrelated/file.ts'], graph)).toBe(1.0);
  });

  it('boosts hub modules', () => {
    const boost = computeGraphBoost(['src/utils/helpers.ts'], graph);
    // src/utils is a hub (0.2 hub boost) + 4 dependents × 0.02 = 0.08 fan-in
    // Total: 1.0 + 0.2 + 0.08 = 1.28
    expect(boost).toBeGreaterThan(1.2);
    expect(boost).toBeLessThanOrEqual(1.4);
  });

  it('applies fan-in boost for non-hub modules', () => {
    const boost = computeGraphBoost(['src/core/types.ts'], graph);
    // src/core has 1 dependent (src/handlers) → 0.02 fan-in, not a hub
    // Total: 1.0 + 0.02 = 1.02
    expect(boost).toBeCloseTo(1.02, 2);
  });

  it('caps fan-in boost at 0.2', () => {
    const bigGraph: GraphContext = {
      edges: { 'src/shared': [] },
      reverseEdges: {
        'src/shared': Array.from({ length: 20 }, (_, i) => `mod${i}`),
      },
      hubModules: [],
    };
    const boost = computeGraphBoost(['src/shared/index.ts'], bigGraph);
    // 20 dependents × 0.02 = 0.40, capped at 0.2 → 1.0 + 0.2 = 1.2
    expect(boost).toBe(1.2);
  });

  it('uses the max boost across multiple matched modules', () => {
    // File touches both src/core (low boost) and src/utils (high boost)
    const boost = computeGraphBoost(
      ['src/core/index.ts', 'src/utils/helpers.ts'],
      graph,
    );
    // Should use the higher boost from src/utils
    expect(boost).toBeGreaterThan(1.2);
  });
});

// ---------------------------------------------------------------------------
// scoreAndRank with graph context
// ---------------------------------------------------------------------------

describe('scoreAndRank with graph context', () => {
  const graph: GraphContext = {
    edges: { 'src/core': ['src/utils'], 'src/leaf': [] },
    reverseEdges: {
      'src/core': ['src/a', 'src/b', 'src/c', 'src/d'],
    },
    hubModules: ['src/core'],
  };

  it('boosts hub-touching proposals above leaf proposals', () => {
    const proposals = [
      makeValidated({ title: 'Leaf', confidence: 80, impact_score: 5, files: ['src/leaf/a.ts'] }),
      makeValidated({ title: 'Hub', confidence: 80, impact_score: 5, files: ['src/core/b.ts'] }),
    ];
    const result = scoreAndRank(proposals, undefined, graph);
    expect(result[0].title).toBe('Hub');
    expect(result[1].title).toBe('Leaf');
  });

  it('without graph context, identical scores produce stable order', () => {
    const proposals = [
      makeValidated({ title: 'A', confidence: 80, impact_score: 5, files: ['src/leaf/a.ts'] }),
      makeValidated({ title: 'B', confidence: 80, impact_score: 5, files: ['src/core/b.ts'] }),
    ];
    const result = scoreAndRank(proposals);
    // Without graph, both have same score — order is stable from input
    expect(result).toHaveLength(2);
  });

  it('graph boost does not override much higher base score', () => {
    const proposals = [
      makeValidated({ title: 'HighBase', confidence: 95, impact_score: 10, files: ['src/leaf/a.ts'] }),
      makeValidated({ title: 'HubLow', confidence: 30, impact_score: 3, files: ['src/core/b.ts'] }),
    ];
    const result = scoreAndRank(proposals, undefined, graph);
    // HighBase: 10 * 95 = 950 (no boost)
    // HubLow: 3 * 30 * ~1.28 = ~115
    expect(result[0].title).toBe('HighBase');
  });
});

// ---------------------------------------------------------------------------
// balanceProposals
// ---------------------------------------------------------------------------

describe('balanceProposals', () => {
  it('returns all when test ratio is within limit', () => {
    const proposals = [
      makeValidated({ category: 'refactor' }),
      makeValidated({ category: 'test' }),
      makeValidated({ category: 'fix' }),
      makeValidated({ category: 'test' }),
      makeValidated({ category: 'docs' }),
    ];
    const result = balanceProposals(proposals, 0.4);
    expect(result).toHaveLength(5);
  });

  it('caps test proposals when exceeding ratio', () => {
    const proposals = [
      makeValidated({ title: 'Refactor', category: 'refactor' }),
      makeValidated({ title: 'Test 1', category: 'test', impact_score: 8 }),
      makeValidated({ title: 'Test 2', category: 'test', impact_score: 5 }),
      makeValidated({ title: 'Test 3', category: 'test', impact_score: 3 }),
    ];
    // maxTests = floor(4 * 0.4) = 1
    const result = balanceProposals(proposals, 0.4);
    const testCount = result.filter(p => p.category === 'test').length;
    expect(testCount).toBe(1);
    // Should keep highest impact test
    expect(result.find(p => p.category === 'test')!.title).toBe('Test 1');
  });

  it('keeps at least 1 test even when all proposals are tests', () => {
    const proposals = [
      makeValidated({ title: 'Test 1', category: 'test', impact_score: 8 }),
      makeValidated({ title: 'Test 2', category: 'test', impact_score: 5 }),
      makeValidated({ title: 'Test 3', category: 'test', impact_score: 3 }),
    ];
    // maxTests = floor(3 * 0.1) = 0, but min 1
    const result = balanceProposals(proposals, 0.1);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Test 1');
  });

  it('uses default ratio when not provided', () => {
    const proposals = Array.from({ length: 10 }, (_, i) =>
      makeValidated({ title: `Test ${i}`, category: 'test', impact_score: 10 - i }),
    );
    const result = balanceProposals(proposals);
    // Default ratio 0.4 → floor(10 * 0.4) = 4
    const testCount = result.filter(p => p.category === 'test').length;
    expect(testCount).toBe(4);
  });

  it('does not mutate input array', () => {
    const proposals = [
      makeValidated({ category: 'test' }),
      makeValidated({ category: 'test' }),
      makeValidated({ category: 'refactor' }),
    ];
    const original = [...proposals];
    balanceProposals(proposals, 0.1);
    expect(proposals).toEqual(original);
  });

  it('handles empty input', () => {
    expect(balanceProposals([], 0.4)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatProposalDescription
// ---------------------------------------------------------------------------

describe('formatProposalDescription', () => {
  it('includes all sections', () => {
    const desc = formatProposalDescription(makeValidated());
    expect(desc).toContain('Three handlers duplicate email validation');
    expect(desc).toContain('## Acceptance Criteria');
    expect(desc).toContain('Single validateEmail() function');
    expect(desc).toContain('## Details');
    expect(desc).toContain('**Risk:** low');
    expect(desc).toContain('**Complexity:** simple');
    expect(desc).toContain('**Confidence:** 85%');
    expect(desc).toContain('**Impact:** 7/10');
    expect(desc).toContain('**Estimated files:** 3');
    expect(desc).toContain('## Rollback');
    expect(desc).toContain('Revert single commit');
  });

  it('includes rationale when present', () => {
    const desc = formatProposalDescription(makeValidated({ rationale: 'Reduces duplication' }));
    expect(desc).toContain('## Rationale');
    expect(desc).toContain('Reduces duplication');
  });

  it('excludes rationale when empty', () => {
    const desc = formatProposalDescription(makeValidated({ rationale: '' }));
    expect(desc).not.toContain('## Rationale');
  });

  it('includes files when present', () => {
    const desc = formatProposalDescription(makeValidated({
      files: ['src/a.ts', 'src/b.ts'],
    }));
    expect(desc).toContain('## Files');
    expect(desc).toContain('`src/a.ts`');
    expect(desc).toContain('`src/b.ts`');
  });

  it('excludes files section when empty', () => {
    const desc = formatProposalDescription(makeValidated({ files: [] }));
    expect(desc).not.toContain('## Files');
  });
});

// ---------------------------------------------------------------------------
// computePriority
// ---------------------------------------------------------------------------

describe('computePriority', () => {
  it('computes impact × confidence / 10', () => {
    expect(computePriority(7, 85)).toBe(Math.round(7 * 85 / 10));
    expect(computePriority(7, 85)).toBe(60);
  });

  it('rounds to nearest integer', () => {
    expect(computePriority(3, 33)).toBe(Math.round(3 * 33 / 10));
    expect(computePriority(3, 33)).toBe(10);
  });

  it('handles maximum values', () => {
    expect(computePriority(10, 100)).toBe(100);
  });

  it('handles zero', () => {
    expect(computePriority(0, 85)).toBe(0);
    expect(computePriority(7, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Severity tiers
// ---------------------------------------------------------------------------

describe('SEVERITY_WEIGHT', () => {
  it('has expected weight values', () => {
    expect(SEVERITY_WEIGHT.blocking).toBe(3);
    expect(SEVERITY_WEIGHT.degrading).toBe(2);
    expect(SEVERITY_WEIGHT.polish).toBe(1);
    expect(SEVERITY_WEIGHT.speculative).toBe(0.5);
  });

  it('covers all ProposalSeverity values', () => {
    const severities: ProposalSeverity[] = ['blocking', 'degrading', 'polish', 'speculative'];
    for (const s of severities) {
      expect(SEVERITY_WEIGHT[s]).toBeGreaterThan(0);
    }
  });
});

describe('normalizeProposal severity', () => {
  it('defaults severity to polish when missing', () => {
    const result = normalizeProposal(makeRaw());
    expect(result.severity).toBe('polish');
  });

  it('preserves valid severity values', () => {
    const severities: ProposalSeverity[] = ['blocking', 'degrading', 'polish', 'speculative'];
    for (const sev of severities) {
      const result = normalizeProposal(makeRaw({ severity: sev }));
      expect(result.severity).toBe(sev);
    }
  });

  it('defaults to polish for invalid severity', () => {
    const result = normalizeProposal(makeRaw({ severity: 'invalid' as any }));
    expect(result.severity).toBe('polish');
  });
});

describe('scoreAndRank with severity', () => {
  it('ranks blocking proposals higher than polish at equal impact/confidence', () => {
    const proposals = [
      makeValidated({ title: 'Polish', severity: 'polish', confidence: 80, impact_score: 7 }),
      makeValidated({ title: 'Blocking', severity: 'blocking', confidence: 80, impact_score: 7 }),
    ];

    const result = scoreAndRank(proposals);
    expect(result[0].title).toBe('Blocking');
    expect(result[1].title).toBe('Polish');
  });

  it('severity can override higher raw score', () => {
    // Blocking (3x): 5 * 70 * 3 = 1050
    // Speculative (0.5x): 9 * 90 * 0.5 = 405
    const proposals = [
      makeValidated({ title: 'Spec', severity: 'speculative', confidence: 90, impact_score: 9 }),
      makeValidated({ title: 'Block', severity: 'blocking', confidence: 70, impact_score: 5 }),
    ];

    const result = scoreAndRank(proposals);
    expect(result[0].title).toBe('Block');
    expect(result[1].title).toBe('Spec');
  });

  it('defaults missing severity to polish weight (1x)', () => {
    const proposals = [
      makeValidated({ title: 'WithSev', severity: 'degrading', confidence: 80, impact_score: 5 }),
      { ...makeValidated({ title: 'NoSev', confidence: 80, impact_score: 5 }), severity: undefined as any },
    ];

    const result = scoreAndRank(proposals);
    // degrading (2x) should beat undefined->polish (1x)
    expect(result[0].title).toBe('WithSev');
  });
});

// ---------------------------------------------------------------------------
// inferSeverity
// ---------------------------------------------------------------------------

describe('inferSeverity', () => {
  it('classifies security category as blocking', () => {
    expect(inferSeverity('security', 'Add CSRF protection')).toBe('blocking');
  });

  it('classifies crash-related descriptions as blocking', () => {
    expect(inferSeverity('fix', 'Fix crash when input is null')).toBe('blocking');
  });

  it('classifies race condition descriptions as blocking', () => {
    expect(inferSeverity('fix', 'Fix race condition in activation promise')).toBe('blocking');
  });

  it('classifies .catch(null) as blocking', () => {
    expect(inferSeverity('fix', 'Fix .catch(null) not suppressing errors')).toBe('blocking');
  });

  it('classifies fix with silent failure as degrading', () => {
    expect(inferSeverity('fix', 'Stop silently swallowing changelog errors')).toBe('degrading');
  });

  it('classifies fix with wrong result as degrading', () => {
    expect(inferSeverity('fix', 'ALB header separator produces wrong output')).toBe('degrading');
  });

  it('classifies plain fix as degrading', () => {
    expect(inferSeverity('fix', 'Fix duplicate ID in test fixture')).toBe('degrading');
  });

  it('classifies docs as polish', () => {
    expect(inferSeverity('docs', 'Add JSDoc to exported functions')).toBe('polish');
  });

  it('classifies types as polish', () => {
    expect(inferSeverity('types', 'Replace any with unknown')).toBe('polish');
  });

  it('classifies cleanup as polish', () => {
    expect(inferSeverity('cleanup', 'Remove dead code')).toBe('polish');
  });

  it('classifies refactor with degrading signals as degrading', () => {
    expect(inferSeverity('refactor', 'Fix missing guard in error path')).toBe('degrading');
  });

  it('classifies speculative descriptions as speculative', () => {
    expect(inferSeverity('refactor', 'Consider extracting this into a helper')).toBe('speculative');
  });

  it('defaults refactor to polish', () => {
    expect(inferSeverity('refactor', 'Extract shared logic')).toBe('polish');
  });

  it('defaults perf to polish', () => {
    expect(inferSeverity('perf', 'Hoist TextEncoder to module scope')).toBe('polish');
  });

  it('normalizeProposal uses inferSeverity when severity not provided', () => {
    const result = normalizeProposal(makeRaw({
      category: 'security',
      description: 'Fix SQL injection vulnerability',
    }));
    expect(result.severity).toBe('blocking');
  });

  it('normalizeProposal preserves explicit severity over inference', () => {
    const result = normalizeProposal(makeRaw({
      category: 'security',
      description: 'Fix SQL injection vulnerability',
      severity: 'polish',
    }));
    expect(result.severity).toBe('polish');
  });
});
