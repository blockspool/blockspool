/**
 * Tests for Spindle loop detection
 */

import { describe, it, expect } from 'vitest';
import {
  computeSimilarity,
  estimateTokens,
  detectOscillation,
  detectRepetition,
  checkSpindleLoop,
  createSpindleState,
  formatSpindleResult,
  DEFAULT_SPINDLE_CONFIG,
  type SpindleConfig,
  type SpindleState,
} from '../lib/spindle.js';

describe('estimateTokens', () => {
  it('estimates tokens from text length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('test')).toBe(1); // 4 chars = 1 token
    expect(estimateTokens('hello world')).toBe(3); // 11 chars = ~3 tokens
    expect(estimateTokens('a'.repeat(100))).toBe(25); // 100 chars = 25 tokens
  });

  it('handles null/undefined gracefully', () => {
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });
});

describe('computeSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(computeSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(computeSimilarity('hello world', 'foo bar baz')).toBe(0);
  });

  it('returns partial similarity for overlapping content', () => {
    const sim = computeSimilarity('the quick brown fox', 'the slow brown dog');
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(0.7);
  });

  it('is case-insensitive', () => {
    expect(computeSimilarity('Hello World', 'hello world')).toBe(1);
  });

  it('handles empty strings', () => {
    expect(computeSimilarity('', '')).toBe(1);
    expect(computeSimilarity('hello', '')).toBe(0);
    expect(computeSimilarity('', 'world')).toBe(0);
  });

  it('ignores punctuation', () => {
    expect(computeSimilarity('hello, world!', 'hello world')).toBe(1);
  });
});

describe('detectOscillation', () => {
  it('returns false for empty or single diff', () => {
    expect(detectOscillation([]).detected).toBe(false);
    expect(detectOscillation(['+line added']).detected).toBe(false);
  });

  it('detects add then remove pattern', () => {
    const diffs = [
      '+const foo = "bar";',
      '-const foo = "bar";',
    ];
    const result = detectOscillation(diffs);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('detects remove then add pattern', () => {
    const diffs = [
      '-const x = 1;',
      '+const x = 1;',
    ];
    const result = detectOscillation(diffs);
    expect(result.detected).toBe(true);
  });

  it('detects oscillation across three diffs', () => {
    const diffs = [
      '+export function helper() { return true; }',
      '-export function helper() { return true; }',
      '+export function helper() { return true; }',
    ];
    const result = detectOscillation(diffs);
    expect(result.detected).toBe(true);
    // Pattern can be "Oscillating" or "Removed then re-added" depending on detection path
    expect(result.pattern).toBeDefined();
  });

  it('does not flag unrelated changes', () => {
    const diffs = [
      '+const a = 1;',
      '+const b = 2;',
      '+const c = 3;',
    ];
    const result = detectOscillation(diffs);
    expect(result.detected).toBe(false);
  });

  it('ignores trivial lines', () => {
    const diffs = [
      '+}',
      '-}',
    ];
    const result = detectOscillation(diffs);
    expect(result.detected).toBe(false);
  });
});

describe('detectRepetition', () => {
  const config = DEFAULT_SPINDLE_CONFIG;

  it('detects similar consecutive outputs', () => {
    const outputs = [
      'Let me try a different approach to solve this problem.',
      'Let me try a different approach to solve this problem.',
    ];
    const result = detectRepetition(
      outputs.slice(0, -1),
      outputs[outputs.length - 1],
      config
    );
    expect(result.detected).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('detects stuck phrases', () => {
    // Need 3+ occurrences of "i apologize" to trigger stuck phrase detection
    const outputs = [
      'I apologize for the confusion. Let me fix this.',
      'I apologize for the error. Let me correct this.',
      'I apologize for the mistake. Let me try again.',
    ];
    const result = detectRepetition(
      outputs.slice(0, -1),
      outputs[outputs.length - 1],
      config
    );
    expect(result.detected).toBe(true);
    expect(result.patterns.some(p => p.toLowerCase().includes('apologize'))).toBe(true);
  });

  it('detects "let me try" repetition', () => {
    // Need 3+ occurrences to trigger stuck phrase detection
    const outputs = [
      'Let me try to implement this feature.',
      'That did not work. Let me try again with a different approach.',
      'Still not right. Let me try a third approach.',
      'Almost there. Let me try one more time.',
    ];
    const latest = outputs[outputs.length - 1];
    const result = detectRepetition(outputs.slice(0, -1), latest, config);
    expect(result.detected).toBe(true);
    expect(result.patterns.some(p => p.includes('let me try'))).toBe(true);
  });

  it('allows different outputs without flagging', () => {
    const outputs = [
      'First, I will analyze the codebase structure.',
      'Now I will implement the feature in src/module.ts.',
    ];
    const result = detectRepetition(
      outputs.slice(0, -1),
      outputs[outputs.length - 1],
      config
    );
    expect(result.detected).toBe(false);
  });
});

describe('checkSpindleLoop', () => {
  it('passes when Spindle is disabled', () => {
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, enabled: false };
    const state = createSpindleState();
    const result = checkSpindleLoop(state, 'any output', null, config);
    expect(result.shouldAbort).toBe(false);
  });

  it('aborts on token budget exceeded', () => {
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, tokenBudgetAbort: 1000 };
    const state = createSpindleState();
    state.estimatedTokens = 500;

    // Add output that pushes over the limit
    const result = checkSpindleLoop(state, 'x'.repeat(2500), null, config);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('token_budget');
    expect(result.confidence).toBe(1.0);
  });

  it('warns but continues at token budget warning', () => {
    const config: SpindleConfig = {
      ...DEFAULT_SPINDLE_CONFIG,
      tokenBudgetWarning: 100,
      tokenBudgetAbort: 200,
    };
    const state = createSpindleState();
    state.estimatedTokens = 90;

    const result = checkSpindleLoop(state, 'x'.repeat(50), null, config);
    expect(result.shouldAbort).toBe(false);
    expect(state.warnings.length).toBeGreaterThan(0);
    expect(state.warnings[0]).toContain('token budget');
  });

  it('aborts on stalling (no changes for N iterations)', () => {
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxStallIterations: 3 };
    const state = createSpindleState();

    // Simulate iterations without changes
    checkSpindleLoop(state, 'output 1', '', config);
    checkSpindleLoop(state, 'output 2', '', config);
    const result = checkSpindleLoop(state, 'output 3', '', config);

    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('stalling');
    expect(result.diagnostics.iterationsWithoutChange).toBe(3);
  });

  it('resets stall counter when changes occur', () => {
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxStallIterations: 3 };
    const state = createSpindleState();

    checkSpindleLoop(state, 'output 1', '', config);
    checkSpindleLoop(state, 'output 2', '', config);
    checkSpindleLoop(state, 'output 3', '+const x = 1;', config); // Change!
    const result = checkSpindleLoop(state, 'output 4', '', config);

    expect(result.shouldAbort).toBe(false);
    expect(state.iterationsSinceChange).toBe(1); // Reset
  });

  it('aborts on oscillating diffs', () => {
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, similarityThreshold: 0.8 };
    const state = createSpindleState();

    checkSpindleLoop(state, 'output', '+const foo = "bar";', config);
    const result = checkSpindleLoop(state, 'output', '-const foo = "bar";', config);

    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('oscillation');
  });

  it('aborts on repeated similar outputs', () => {
    const config: SpindleConfig = {
      ...DEFAULT_SPINDLE_CONFIG,
      maxSimilarOutputs: 2,
      similarityThreshold: 0.8,
    };
    const state = createSpindleState();

    checkSpindleLoop(state, 'Let me try a different approach to fix this.', '+a', config);
    const result = checkSpindleLoop(
      state,
      'Let me try a different approach to fix this.',
      '+b',
      config
    );

    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('repetition');
  });

  it('tracks estimated tokens correctly', () => {
    const state = createSpindleState();
    const config = DEFAULT_SPINDLE_CONFIG;

    checkSpindleLoop(state, 'hello world', '+code', config); // ~3 + ~1 tokens
    expect(state.estimatedTokens).toBeGreaterThan(0);
    expect(state.estimatedTokens).toBeLessThan(20);

    checkSpindleLoop(state, 'more output', '+more code', config);
    expect(state.estimatedTokens).toBeGreaterThan(4);
  });

  it('maintains output and diff history', () => {
    const state = createSpindleState();
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxSimilarOutputs: 3 };

    checkSpindleLoop(state, 'output 1', '+diff 1', config);
    checkSpindleLoop(state, 'output 2', '+diff 2', config);
    checkSpindleLoop(state, 'output 3', '+diff 3', config);
    checkSpindleLoop(state, 'output 4', '+diff 4', config);

    // Should keep last N+1 outputs (for comparison)
    expect(state.outputs.length).toBe(4);
    expect(state.outputs[0]).toBe('output 1');
    expect(state.outputs[3]).toBe('output 4');

    // Should keep last 5 diffs
    expect(state.diffs.length).toBe(4);
  });
});

describe('formatSpindleResult', () => {
  it('formats non-abort result', () => {
    const result = formatSpindleResult({
      shouldAbort: false,
      confidence: 0,
      diagnostics: {},
    });
    expect(result).toBe('No spindle loop detected');
  });

  it('formats token budget abort', () => {
    const result = formatSpindleResult({
      shouldAbort: true,
      reason: 'token_budget',
      confidence: 1.0,
      diagnostics: { estimatedTokens: 150000 },
    });
    expect(result).toContain('token_budget');
    expect(result).toContain('150000');
  });

  it('formats oscillation abort', () => {
    const result = formatSpindleResult({
      shouldAbort: true,
      reason: 'oscillation',
      confidence: 0.85,
      diagnostics: { oscillationPattern: 'Added then removed: const x...' },
    });
    expect(result).toContain('oscillation');
    expect(result).toContain('85%');
    expect(result).toContain('Added then removed');
  });

  it('formats repetition abort', () => {
    const result = formatSpindleResult({
      shouldAbort: true,
      reason: 'repetition',
      confidence: 0.9,
      diagnostics: { repeatedPatterns: ['let me try', 'i apologize'] },
    });
    expect(result).toContain('repetition');
    expect(result).toContain('let me try');
  });
});

describe('createSpindleState', () => {
  it('creates clean initial state', () => {
    const state = createSpindleState();
    expect(state.outputs).toEqual([]);
    expect(state.diffs).toEqual([]);
    expect(state.iterationsSinceChange).toBe(0);
    expect(state.estimatedTokens).toBe(0);
    expect(state.warnings).toEqual([]);
    expect(state.totalOutputChars).toBe(0);
    expect(state.totalChangeChars).toBe(0);
  });
});

describe('integration scenarios', () => {
  it('simulates healthy run', () => {
    const state = createSpindleState();
    const config = DEFAULT_SPINDLE_CONFIG;

    const outputs = [
      'Analyzing the codebase structure...',
      'Found the issue in src/module.ts, implementing fix.',
      'Fix complete, running tests to verify.',
    ];
    const diffs = [
      '',
      '+export function fix() { return true; }',
      '+test("fix works", () => expect(fix()).toBe(true));',
    ];

    for (let i = 0; i < outputs.length; i++) {
      const result = checkSpindleLoop(state, outputs[i], diffs[i], config);
      expect(result.shouldAbort).toBe(false);
    }
  });

  it('simulates stuck agent', () => {
    const state = createSpindleState();
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxSimilarOutputs: 2 };

    const stuckOutputs = [
      'Let me try to fix this by modifying the function...',
      'That approach did not work. Let me try a different way...',
      'Let me try to fix this by modifying the function...',
    ];

    let aborted = false;
    for (const output of stuckOutputs) {
      const result = checkSpindleLoop(state, output, '', config);
      if (result.shouldAbort) {
        aborted = true;
        expect(result.reason).toBe('repetition');
        break;
      }
    }
    expect(aborted).toBe(true);
  });

  it('simulates oscillating agent', () => {
    const state = createSpindleState();
    const config = DEFAULT_SPINDLE_CONFIG;

    const oscillatingDiffs = [
      '+const DEBUG = true;',
      '-const DEBUG = true;\n+const DEBUG = false;',
      '-const DEBUG = false;\n+const DEBUG = true;',
    ];

    let aborted = false;
    for (const diff of oscillatingDiffs) {
      const result = checkSpindleLoop(state, 'output', diff, config);
      if (result.shouldAbort) {
        aborted = true;
        expect(result.reason).toBe('oscillation');
        break;
      }
    }
    expect(aborted).toBe(true);
  });
});
