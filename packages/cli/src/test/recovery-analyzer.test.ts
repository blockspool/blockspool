import { describe, it, expect } from 'vitest';
import { analyzeFailure } from '../lib/recovery-analyzer.js';
import type { RunTicketResult } from '../lib/solo-ticket-types.js';
import type { TicketProposal } from '@promptwheel/core/scout';

function makeResult(overrides: Partial<RunTicketResult> = {}): RunTicketResult {
  return {
    success: false,
    durationMs: 1000,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<TicketProposal> = {}): TicketProposal {
  return {
    id: 'scout-test-001',
    title: 'Test proposal',
    description: 'Test description',
    category: 'refactor',
    estimated_complexity: 'moderate',
    confidence: 80,
    impact_score: 5,
    files: ['src/foo.ts', 'src/bar.ts'],
    allowed_paths: ['src/'],
    rationale: 'Test rationale',
    acceptance_criteria: ['Tests pass'],
    verification_commands: ['npm test'],
    ...overrides,
  };
}

describe('analyzeFailure', () => {
  it('skips on timeout', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'timeout' }),
      makeProposal(),
    );
    expect(result.action).toBe('skip');
  });

  it('retries with hint on spindle oscillation', () => {
    const result = analyzeFailure(
      makeResult({
        failureReason: 'spindle_abort',
        spindle: {
          trigger: 'oscillation',
          confidence: 90,
          estimatedTokens: 50000,
          iteration: 10,
          thresholds: { similarityThreshold: 0.8, maxSimilarOutputs: 3, maxStallIterations: 5, tokenBudgetWarning: 40000, tokenBudgetAbort: 80000 },
          metrics: {},
          recommendations: [],
          artifactPath: '/tmp/test',
        },
      }),
      makeProposal(),
    );
    expect(result.action).toBe('retry_with_hint');
    if (result.action === 'retry_with_hint') {
      expect(result.hint).toContain('oscillation');
    }
  });

  it('retries with hint on spindle spinning', () => {
    const result = analyzeFailure(
      makeResult({
        failureReason: 'spindle_abort',
        spindle: {
          trigger: 'spinning',
          confidence: 85,
          estimatedTokens: 45000,
          iteration: 12,
          thresholds: { similarityThreshold: 0.8, maxSimilarOutputs: 3, maxStallIterations: 5, tokenBudgetWarning: 40000, tokenBudgetAbort: 80000 },
          metrics: {},
          recommendations: [],
          artifactPath: '/tmp/test',
        },
      }),
      makeProposal(),
    );
    expect(result.action).toBe('retry_with_hint');
    if (result.action === 'retry_with_hint') {
      expect(result.hint).toContain('spinning');
    }
  });

  it('retries with hint on qa_ping_pong', () => {
    const result = analyzeFailure(
      makeResult({
        failureReason: 'spindle_abort',
        spindle: {
          trigger: 'qa_ping_pong',
          confidence: 85,
          estimatedTokens: 40000,
          iteration: 8,
          thresholds: { similarityThreshold: 0.8, maxSimilarOutputs: 3, maxStallIterations: 5, tokenBudgetWarning: 40000, tokenBudgetAbort: 80000 },
          metrics: {},
          recommendations: [],
          artifactPath: '/tmp/test',
        },
      }),
      makeProposal(),
    );
    expect(result.action).toBe('retry_with_hint');
    if (result.action === 'retry_with_hint') {
      expect(result.hint).toContain('test');
    }
  });

  it('skips on other spindle triggers', () => {
    const result = analyzeFailure(
      makeResult({
        failureReason: 'spindle_abort',
        spindle: {
          trigger: 'token_budget',
          confidence: 95,
          estimatedTokens: 100000,
          iteration: 20,
          thresholds: { similarityThreshold: 0.8, maxSimilarOutputs: 3, maxStallIterations: 5, tokenBudgetWarning: 40000, tokenBudgetAbort: 80000 },
          metrics: {},
          recommendations: [],
          artifactPath: '/tmp/test',
        },
      }),
      makeProposal(),
    );
    expect(result.action).toBe('skip');
  });

  it('narrows scope on scope_violation when narrower scope available', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'scope_violation' }),
      makeProposal({ files: ['src/foo.ts', 'src/bar.ts', 'src/**/*.ts'] }),
    );
    expect(result.action).toBe('narrow_scope');
    if (result.action === 'narrow_scope') {
      expect(result.files).toEqual(['src/foo.ts', 'src/bar.ts']);
    }
  });

  it('skips scope_violation when no narrower scope available', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'scope_violation' }),
      makeProposal({ files: ['src/foo.ts', 'src/bar.ts'] }),
    );
    // All files are concrete (no globs), so targetFiles.length === files.length — no narrowing possible
    expect(result.action).toBe('skip');
  });

  it('retries with hint on QA failure', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'qa_failed', error: 'FAIL src/auth.test.ts - login should work' }),
      makeProposal(),
    );
    expect(result.action).toBe('retry_with_hint');
  });

  it('skips on git error', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'git_error', error: 'merge conflict' }),
      makeProposal(),
    );
    expect(result.action).toBe('skip');
  });

  it('skips on pr error', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'pr_error', error: 'PR creation failed' }),
      makeProposal(),
    );
    expect(result.action).toBe('skip');
  });

  it('retries agent error with permission hint', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'agent_error', error: 'Permission denied: /etc/hosts' }),
      makeProposal(),
    );
    expect(result.action).toBe('retry_with_hint');
    if (result.action === 'retry_with_hint') {
      expect(result.hint).toContain('permission');
    }
  });

  it('retries agent error with not-found hint', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'agent_error', error: 'No such file or directory: /src/missing.ts' }),
      makeProposal(),
    );
    expect(result.action).toBe('retry_with_hint');
    if (result.action === 'retry_with_hint') {
      expect(result.hint).toContain('file');
    }
  });

  it('retries agent error with generic long error text', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'agent_error', error: 'Something unexpected happened during execution that caused a failure in the process' }),
      makeProposal(),
    );
    expect(result.action).toBe('retry_with_hint');
    if (result.action === 'retry_with_hint') {
      expect(result.hint).toContain('different approach');
    }
  });

  it('skips unknown failures with no error text', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'agent_error', error: '' }),
      makeProposal(),
    );
    expect(result.action).toBe('skip');
  });

  it('skips unknown failures with short error text', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: 'agent_error', error: 'fail' }),
      makeProposal(),
    );
    expect(result.action).toBe('skip');
  });

  it('defaults failureReason to agent_error when undefined', () => {
    const result = analyzeFailure(
      makeResult({ failureReason: undefined, error: '' }),
      makeProposal(),
    );
    // agent_error with empty error text → skip
    expect(result.action).toBe('skip');
  });
});
