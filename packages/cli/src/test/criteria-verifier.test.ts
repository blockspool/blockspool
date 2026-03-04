import { describe, it, expect, vi } from 'vitest';

// Mock runClaude before importing the module under test
const mockRunClaude = vi.fn();
vi.mock('@promptwheel/core/scout', () => ({
  runClaude: (...args: unknown[]) => mockRunClaude(...args),
}));

const { verifyCriteria } = await import('../lib/criteria-verifier.js');

describe('verifyCriteria', () => {
  it('returns allPassed=true when no criteria', async () => {
    const result = await verifyCriteria('some diff', [], 'Test ticket', '/tmp');
    expect(result.allPassed).toBe(true);
    expect(result.results).toEqual([]);
    expect(mockRunClaude).not.toHaveBeenCalled();
  });

  it('parses valid JSON response and reports all passed', async () => {
    mockRunClaude.mockResolvedValueOnce({
      success: true,
      output: JSON.stringify([
        { criterion: 'Tests pass', passed: true, evidence: 'All tests green' },
        { criterion: 'No injection', passed: true, evidence: 'Uses parameterized queries' },
      ]),
      durationMs: 500,
    });

    const result = await verifyCriteria(
      'diff --git a/foo.ts\n+safe code',
      ['Tests pass', 'No injection'],
      'Security fix',
      '/tmp',
    );

    expect(result.allPassed).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      criterion: 'Tests pass',
      passed: true,
      evidence: 'All tests green',
    });
  });

  it('reports allPassed=false when a criterion fails', async () => {
    mockRunClaude.mockResolvedValueOnce({
      success: true,
      output: JSON.stringify([
        { criterion: 'Input sanitized', passed: false, evidence: 'Raw input passed to exec()' },
        { criterion: 'Tests pass', passed: true, evidence: 'Test suite exits 0' },
      ]),
      durationMs: 500,
    });

    const result = await verifyCriteria(
      'diff content',
      ['Input sanitized', 'Tests pass'],
      'Sanitize input',
      '/tmp',
    );

    expect(result.allPassed).toBe(false);
    expect(result.results.find(r => r.criterion === 'Input sanitized')?.passed).toBe(false);
    expect(result.results.find(r => r.criterion === 'Tests pass')?.passed).toBe(true);
  });

  it('parses JSON wrapped in markdown code block', async () => {
    mockRunClaude.mockResolvedValueOnce({
      success: true,
      output: '```json\n[{"criterion":"Fix applied","passed":true,"evidence":"Done"}]\n```',
      durationMs: 500,
    });

    const result = await verifyCriteria('diff', ['Fix applied'], 'Fix bug', '/tmp');
    expect(result.allPassed).toBe(true);
    expect(result.results[0].criterion).toBe('Fix applied');
  });

  it('parses JSON array embedded in text', async () => {
    mockRunClaude.mockResolvedValueOnce({
      success: true,
      output: 'Here are the results:\n[{"criterion":"Safe","passed":true,"evidence":"OK"}]\nAll done.',
      durationMs: 500,
    });

    const result = await verifyCriteria('diff', ['Safe'], 'Safety check', '/tmp');
    expect(result.allPassed).toBe(true);
  });

  it('fail-open on LLM call failure', async () => {
    mockRunClaude.mockResolvedValueOnce({
      success: false,
      output: '',
      error: 'Connection timeout',
      durationMs: 5000,
    });

    const result = await verifyCriteria('diff', ['Criterion A'], 'Ticket', '/tmp');
    expect(result.allPassed).toBe(true);
    expect(result.results[0].evidence).toContain('failed');
  });

  it('fail-open on unparseable output', async () => {
    mockRunClaude.mockResolvedValueOnce({
      success: true,
      output: 'I could not evaluate the criteria because the diff is too complex.',
      durationMs: 500,
    });

    const result = await verifyCriteria('diff', ['Criterion A'], 'Ticket', '/tmp');
    expect(result.allPassed).toBe(true);
    expect(result.results[0].evidence).toContain('unparseable');
  });

  it('fail-open on exception', async () => {
    mockRunClaude.mockRejectedValueOnce(new Error('Unexpected error'));

    const result = await verifyCriteria('diff', ['Criterion A'], 'Ticket', '/tmp');
    expect(result.allPassed).toBe(true);
    expect(result.results[0].evidence).toContain('error');
  });

  it('fills missing criteria results (fail-open)', async () => {
    mockRunClaude.mockResolvedValueOnce({
      success: true,
      output: JSON.stringify([
        { criterion: 'First', passed: true, evidence: 'OK' },
        // Second criterion missing from response
      ]),
      durationMs: 500,
    });

    const result = await verifyCriteria('diff', ['First', 'Second'], 'Ticket', '/tmp');
    expect(result.results).toHaveLength(2);
    expect(result.results.find(r => r.criterion === 'Second')?.passed).toBe(true);
    expect(result.results.find(r => r.criterion === 'Second')?.evidence).toContain('Not evaluated');
  });

  it('truncates long diffs', async () => {
    const longDiff = 'x'.repeat(10_000);
    mockRunClaude.mockResolvedValueOnce({
      success: true,
      output: JSON.stringify([{ criterion: 'A', passed: true, evidence: 'OK' }]),
      durationMs: 500,
    });

    await verifyCriteria(longDiff, ['A'], 'Ticket', '/tmp');

    const callArgs = mockRunClaude.mock.calls[mockRunClaude.mock.calls.length - 1][0];
    // Prompt should contain truncated diff, not the full 10k
    expect(callArgs.prompt.length).toBeLessThan(10_000);
    expect(callArgs.prompt).toContain('truncated');
  });

  it('uses sonnet model by default', async () => {
    mockRunClaude.mockResolvedValueOnce({
      success: true,
      output: JSON.stringify([{ criterion: 'A', passed: true, evidence: 'OK' }]),
      durationMs: 500,
    });

    await verifyCriteria('diff', ['A'], 'Ticket', '/tmp');

    const callArgs = mockRunClaude.mock.calls[mockRunClaude.mock.calls.length - 1][0];
    expect(callArgs.model).toBe('sonnet');
  });
});
