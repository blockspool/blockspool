/**
 * Tests for consolidateLearnings structured knowledge merge behavior.
 *
 * Verifies that when two learnings are merged, the higher-weight entry's
 * structured knowledge fields (root_cause, failure_context) are preferred.
 */

import { describe, it, expect } from 'vitest';
import {
  type Learning,
  consolidateLearnings,
  LEARNINGS_DEFAULTS,
} from '../learnings/shared.js';

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: 'test-1',
    text: 'Test learning',
    category: 'gotcha',
    source: { type: 'qa_failure' },
    tags: [],
    weight: 50,
    created_at: new Date().toISOString(),
    last_confirmed_at: new Date().toISOString(),
    access_count: 0,
    ...overrides,
  };
}

describe('consolidateLearnings structured knowledge merge', () => {
  it('prefers higher-weight entry root_cause and failure_context when j wins', () => {
    // Need enough entries to exceed CONSOLIDATION_THRESHOLD
    const learnings: Learning[] = [];
    for (let i = 0; i < LEARNINGS_DEFAULTS.CONSOLIDATION_THRESHOLD + 2; i++) {
      learnings.push(makeLearning({
        id: `l-${i}`,
        text: i < 2 ? 'Fix the authentication bug in the login handler' : `Unique learning number ${i}`,
        weight: i === 0 ? 30 : i === 1 ? 80 : 50,
        structured: i === 0
          ? { root_cause: 'loser-cause', failure_context: 'loser-context' }
          : i === 1
            ? { root_cause: 'winner-cause', failure_context: 'winner-context' }
            : undefined,
      }));
    }

    const result = consolidateLearnings(learnings);
    if (result !== null) {
      // Entry 1 (weight 80) should win over entry 0 (weight 30)
      const merged = result.find(l => l.id === 'l-0');
      expect(merged).toBeDefined();
      // Winner's text should replace loser's
      expect(merged!.text).toBe('Fix the authentication bug in the login handler');
      // Winner's weight should be kept
      expect(merged!.weight).toBe(80);
      // Winner's structured knowledge should be preferred
      expect(merged!.structured?.root_cause).toBe('winner-cause');
      expect(merged!.structured?.failure_context).toBe('winner-context');
    }
  });

  it('keeps entry i structured fields when i has higher weight', () => {
    const learnings: Learning[] = [];
    for (let i = 0; i < LEARNINGS_DEFAULTS.CONSOLIDATION_THRESHOLD + 2; i++) {
      learnings.push(makeLearning({
        id: `l-${i}`,
        text: i < 2 ? 'Fix the authentication bug in the login handler' : `Unique learning number ${i}`,
        weight: i === 0 ? 90 : i === 1 ? 40 : 50,
        structured: i === 0
          ? { root_cause: 'i-cause', failure_context: 'i-context' }
          : i === 1
            ? { root_cause: 'j-cause', failure_context: 'j-context' }
            : undefined,
      }));
    }

    const result = consolidateLearnings(learnings);
    if (result !== null) {
      const merged = result.find(l => l.id === 'l-0');
      expect(merged).toBeDefined();
      // Entry i wins — its structured fields should be kept
      expect(merged!.structured?.root_cause).toBe('i-cause');
      expect(merged!.structured?.failure_context).toBe('i-context');
    }
  });

  it('falls back to loser fields when winner has no structured data', () => {
    const learnings: Learning[] = [];
    for (let i = 0; i < LEARNINGS_DEFAULTS.CONSOLIDATION_THRESHOLD + 2; i++) {
      learnings.push(makeLearning({
        id: `l-${i}`,
        text: i < 2 ? 'Fix the authentication bug in the login handler' : `Unique learning number ${i}`,
        weight: i === 0 ? 30 : i === 1 ? 80 : 50,
        structured: i === 0
          ? { root_cause: 'fallback-cause', failure_context: 'fallback-context' }
          : undefined,
      }));
    }

    const result = consolidateLearnings(learnings);
    if (result !== null) {
      const merged = result.find(l => l.id === 'l-0');
      expect(merged).toBeDefined();
      // Winner (j) has no structured data, so loser's (i's) should be kept
      expect(merged!.structured?.root_cause).toBe('fallback-cause');
      expect(merged!.structured?.failure_context).toBe('fallback-context');
    }
  });
});
