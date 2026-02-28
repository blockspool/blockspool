import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { warnDeprecatedFlags } from '../lib/deprecation.js';

describe('warnDeprecatedFlags', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('returns 0 and prints nothing for clean options', () => {
    const count = warnDeprecatedFlags({ hours: '2', scope: 'src' });
    expect(count).toBe(0);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('warns for --minutes', () => {
    const count = warnDeprecatedFlags({ minutes: '30' });
    expect(count).toBe(1);
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('--minutes is deprecated');
    expect(output).toContain('--hours');
  });

  it('warns for --scout-backend and suggests --provider', () => {
    const count = warnDeprecatedFlags({ scoutBackend: 'codex' });
    expect(count).toBe(1);
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('--scout-backend is deprecated');
    expect(output).toContain('--provider');
  });

  it('warns for --no-draft (draft === false)', () => {
    const count = warnDeprecatedFlags({ draft: false });
    expect(count).toBe(1);
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('--no-draft is deprecated');
  });

  it('does not warn for draft === true (default)', () => {
    const count = warnDeprecatedFlags({ draft: true });
    expect(count).toBe(0);
  });

  it('warns for --no-docs-audit (docsAudit === false)', () => {
    const count = warnDeprecatedFlags({ docsAudit: false });
    expect(count).toBe(1);
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('--no-docs-audit is deprecated');
  });

  it('counts multiple deprecated flags', () => {
    const count = warnDeprecatedFlags({
      minutes: '60',
      cycles: '3',
      maxPrs: '5',
      scoutBackend: 'codex',
      executeBackend: 'codex',
    });
    expect(count).toBe(5);
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('5 deprecated flags');
  });

  it('does not warn for undefined values', () => {
    const count = warnDeprecatedFlags({
      minutes: undefined,
      cycles: undefined,
      scoutBackend: undefined,
    });
    expect(count).toBe(0);
  });

  it('includes removal notice', () => {
    warnDeprecatedFlags({ minutes: '30' });
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('removed in a future release');
  });
});
