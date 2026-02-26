/**
 * AST pattern scanning tests — covers functions in codebase-index/ast-patterns.ts:
 *   - FINDINGS_VERSION is a number
 *   - scanPatterns with empty results
 *   - Language filtering (JS patterns skip Python)
 *   - empty-catch pattern
 *   - type-assertion-heavy pattern (threshold >3)
 *   - large-function pattern
 *   - any-annotation pattern (threshold >3)
 *   - bare-except pattern
 */

import { describe, it, expect } from 'vitest';
import {
  FINDINGS_VERSION,
  getPatterns,
  scanPatterns,
} from '../codebase-index/ast-patterns.js';
import type { AstGrepNode } from '../codebase-index/ast-analysis.js';

// ---------------------------------------------------------------------------
// Mock AST node helper
// ---------------------------------------------------------------------------

function mockNode(
  kind: string,
  text: string,
  children: ReturnType<typeof mockNode>[] = [],
): AstGrepNode {
  const node: AstGrepNode = {
    kind: () => kind,
    text: () => text,
    children: () => children,
    findAll: (rule: { rule: { kind: string } }) => {
      const results: AstGrepNode[] = [];
      const stack = [...children];
      while (stack.length > 0) {
        const n = stack.pop()!;
        if (n.kind() === rule.rule.kind) results.push(n);
        stack.push(...n.children());
      }
      return results;
    },
    isNamed: () => true,
  };
  return node;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FINDINGS_VERSION', () => {
  it('is a positive integer', () => {
    expect(typeof FINDINGS_VERSION).toBe('number');
    expect(FINDINGS_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(FINDINGS_VERSION)).toBe(true);
  });
});

describe('getPatterns', () => {
  it('returns a non-empty array of patterns', () => {
    const patterns = getPatterns();
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) {
      expect(p.id).toBeTruthy();
      expect(p.langs.length).toBeGreaterThan(0);
      expect(typeof p.scan).toBe('function');
    }
  });
});

describe('scanPatterns', () => {
  const patterns = getPatterns();

  it('returns empty array when nothing matches', () => {
    const root = mockNode('program', 'const x = 1;', []);
    const result = scanPatterns(root, 'TypeScript', 'const x = 1;', patterns);
    expect(result).toEqual([]);
  });

  it('filters patterns by language family — JS patterns skip Python', () => {
    // Build a node tree with a catch_clause that has an empty body.
    // When scanned as Python, the empty-catch (JS-only) pattern should NOT fire.
    const catchNode = mockNode('catch_clause', 'catch (e) {}', []);
    const root = mockNode('program', 'catch (e) {}', [catchNode]);
    const result = scanPatterns(root, 'Python', 'catch (e) {}', patterns);
    // empty-catch only fires for JS family
    const emptyCatch = result.filter(f => f.patternId === 'empty-catch');
    expect(emptyCatch).toEqual([]);
  });

  it('JS patterns fire for TypeScript', () => {
    const catchNode = mockNode('catch_clause', 'catch (e) {}', []);
    const root = mockNode('program', 'catch (e) {}', [catchNode]);
    const result = scanPatterns(root, 'TypeScript', 'catch (e) {}', patterns);
    const emptyCatch = result.filter(f => f.patternId === 'empty-catch');
    expect(emptyCatch.length).toBe(1);
  });
});

describe('empty-catch pattern', () => {
  const patterns = getPatterns();

  it('detects catch with empty body', () => {
    const content = 'try { foo(); } catch (e) {}';
    const catchNode = mockNode('catch_clause', 'catch (e) {}', []);
    const root = mockNode('program', content, [catchNode]);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'empty-catch');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('medium');
    expect(match!.category).toBe('fix');
  });

  it('detects catch with comment-only body', () => {
    const content = 'try { foo(); } catch (e) { // ignore\n}';
    const catchNode = mockNode('catch_clause', 'catch (e) { // ignore\n}', []);
    const root = mockNode('program', content, [catchNode]);
    const findings = scanPatterns(root, 'JavaScript', content, patterns);
    const match = findings.find(f => f.patternId === 'empty-catch');
    expect(match).toBeDefined();
  });

  it('does NOT detect catch with real body', () => {
    const content = 'try { foo(); } catch (e) { console.log(e); }';
    const catchNode = mockNode('catch_clause', 'catch (e) { console.log(e); }', []);
    const root = mockNode('program', content, [catchNode]);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'empty-catch');
    expect(match).toBeUndefined();
  });
});

describe('type-assertion-heavy pattern', () => {
  const patterns = getPatterns();

  it('does NOT trigger with 3 or fewer as_expression nodes', () => {
    const asNodes = Array.from({ length: 3 }, (_, i) =>
      mockNode('as_expression', `x as Type${i}`, []),
    );
    const root = mockNode('program', 'code', asNodes);
    const findings = scanPatterns(root, 'TypeScript', 'code', patterns);
    const match = findings.find(f => f.patternId === 'type-assertion-heavy');
    expect(match).toBeUndefined();
  });

  it('triggers with more than 3 as_expression nodes', () => {
    const asNodes = Array.from({ length: 5 }, (_, i) =>
      mockNode('as_expression', `x as Type${i}`, []),
    );
    const root = mockNode('program', 'code', asNodes);
    const findings = scanPatterns(root, 'TypeScript', 'code', patterns);
    const match = findings.find(f => f.patternId === 'type-assertion-heavy');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('medium');
    expect(match!.category).toBe('types');
    expect(match!.message).toContain('5');
  });
});

describe('large-function pattern', () => {
  const patterns = getPatterns();

  it('detects functions over 50 lines (JS)', () => {
    const longBody = Array.from({ length: 55 }, (_, i) => `  const x${i} = ${i};`).join('\n');
    const fnText = `function bigFn() {\n${longBody}\n}`;
    const fnNode = mockNode('function_declaration', fnText, []);
    const root = mockNode('program', fnText, [fnNode]);
    const findings = scanPatterns(root, 'TypeScript', fnText, patterns);
    const match = findings.find(f => f.patternId === 'large-function');
    expect(match).toBeDefined();
    expect(match!.message).toContain('bigFn');
    expect(match!.category).toBe('refactor');
  });

  it('detects functions over 50 lines (Python)', () => {
    const longBody = Array.from({ length: 55 }, (_, i) => `    x${i} = ${i}`).join('\n');
    const fnText = `def big_fn():\n${longBody}`;
    const fnNode = mockNode('function_definition', fnText, []);
    const root = mockNode('program', fnText, [fnNode]);
    const findings = scanPatterns(root, 'Python', fnText, patterns);
    const match = findings.find(f => f.patternId === 'large-function');
    expect(match).toBeDefined();
    expect(match!.message).toContain('big_fn');
  });

  it('does NOT trigger for functions under 50 lines', () => {
    const shortBody = Array.from({ length: 10 }, (_, i) => `  const x${i} = ${i};`).join('\n');
    const fnText = `function smallFn() {\n${shortBody}\n}`;
    const fnNode = mockNode('function_declaration', fnText, []);
    const root = mockNode('program', fnText, [fnNode]);
    const findings = scanPatterns(root, 'TypeScript', fnText, patterns);
    const match = findings.find(f => f.patternId === 'large-function');
    expect(match).toBeUndefined();
  });
});

describe('any-annotation pattern', () => {
  const patterns = getPatterns();

  it('does NOT trigger with 3 or fewer any annotations', () => {
    const anyNodes = Array.from({ length: 3 }, () =>
      mockNode('predefined_type', 'any', []),
    );
    const root = mockNode('program', 'code', anyNodes);
    const findings = scanPatterns(root, 'TypeScript', 'code', patterns);
    const match = findings.find(f => f.patternId === 'any-annotation');
    expect(match).toBeUndefined();
  });

  it('triggers with more than 3 any annotations', () => {
    const anyNodes = Array.from({ length: 6 }, () =>
      mockNode('predefined_type', 'any', []),
    );
    const root = mockNode('program', 'code', anyNodes);
    const findings = scanPatterns(root, 'TypeScript', 'code', patterns);
    const match = findings.find(f => f.patternId === 'any-annotation');
    expect(match).toBeDefined();
    expect(match!.message).toContain('6');
    expect(match!.category).toBe('types');
  });

  it('ignores predefined_type nodes that are not "any"', () => {
    const nodes = [
      ...Array.from({ length: 5 }, () => mockNode('predefined_type', 'string', [])),
      ...Array.from({ length: 2 }, () => mockNode('predefined_type', 'any', [])),
    ];
    const root = mockNode('program', 'code', nodes);
    const findings = scanPatterns(root, 'TypeScript', 'code', patterns);
    const match = findings.find(f => f.patternId === 'any-annotation');
    expect(match).toBeUndefined();
  });
});

describe('bare-except pattern', () => {
  const patterns = getPatterns();

  it('detects bare except clause in Python', () => {
    const content = 'try:\n    pass\nexcept:\n    pass';
    const exceptNode = mockNode('except_clause', 'except:\n    pass', []);
    const root = mockNode('program', content, [exceptNode]);
    const findings = scanPatterns(root, 'Python', content, patterns);
    const match = findings.find(f => f.patternId === 'bare-except');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('high');
    expect(match!.category).toBe('fix');
  });

  it('does NOT detect typed except clause', () => {
    const content = 'try:\n    pass\nexcept ValueError:\n    pass';
    const exceptNode = mockNode('except_clause', 'except ValueError:\n    pass', []);
    const root = mockNode('program', content, [exceptNode]);
    const findings = scanPatterns(root, 'Python', content, patterns);
    const match = findings.find(f => f.patternId === 'bare-except');
    expect(match).toBeUndefined();
  });

  it('does NOT fire for JS files', () => {
    const content = 'except:\n    pass';
    const exceptNode = mockNode('except_clause', 'except:\n    pass', []);
    const root = mockNode('program', content, [exceptNode]);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'bare-except');
    expect(match).toBeUndefined();
  });
});
