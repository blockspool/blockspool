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

// ---------------------------------------------------------------------------
// New patterns: console-log, hardcoded-secret, todo-fixme, deeply-nested,
// non-null-assertion-heavy, unreachable-code
// ---------------------------------------------------------------------------

describe('console-log pattern', () => {
  const patterns = getPatterns();

  it('detects console.log calls', () => {
    const content = 'function foo() { console.log("debug"); }';
    const callNode = mockNode('call_expression', 'console.log("debug")', []);
    const root = mockNode('program', content, [callNode]);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'console-log');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('low');
    expect(match!.category).toBe('cleanup');
  });

  it('detects console.warn and console.error', () => {
    const content = 'console.warn("x"); console.error("y");';
    const nodes = [
      mockNode('call_expression', 'console.warn("x")', []),
      mockNode('call_expression', 'console.error("y")', []),
    ];
    const root = mockNode('program', content, nodes);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const matches = findings.filter(f => f.patternId === 'console-log');
    expect(matches.length).toBe(2);
  });

  it('does NOT flag non-console call expressions', () => {
    const content = 'logger.log("ok");';
    const callNode = mockNode('call_expression', 'logger.log("ok")', []);
    const root = mockNode('program', content, [callNode]);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'console-log');
    expect(match).toBeUndefined();
  });

  it('does NOT fire for Python', () => {
    const content = 'console.log("test")';
    const callNode = mockNode('call_expression', 'console.log("test")', []);
    const root = mockNode('program', content, [callNode]);
    const findings = scanPatterns(root, 'Python', content, patterns);
    const match = findings.find(f => f.patternId === 'console-log');
    expect(match).toBeUndefined();
  });
});

describe('hardcoded-secret pattern', () => {
  const patterns = getPatterns();

  it('detects hardcoded API keys', () => {
    const content = 'const api_key = "sk-1234567890abcdef";';
    const root = mockNode('program', content, []);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'hardcoded-secret');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('high');
    expect(match!.category).toBe('security');
  });

  it('detects password assignments', () => {
    const content = 'password = "super_secret_password_123"';
    const root = mockNode('program', content, []);
    const findings = scanPatterns(root, 'Python', content, patterns);
    const match = findings.find(f => f.patternId === 'hardcoded-secret');
    expect(match).toBeDefined();
  });

  it('skips test/mock values', () => {
    const content = 'const api_key = "test-mock-placeholder-key";';
    const root = mockNode('program', content, []);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'hardcoded-secret');
    expect(match).toBeUndefined();
  });

  it('skips short values (< 8 chars)', () => {
    const content = 'const token = "short";';
    const root = mockNode('program', content, []);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'hardcoded-secret');
    expect(match).toBeUndefined();
  });
});

describe('todo-fixme pattern', () => {
  const patterns = getPatterns();

  it('detects TODO comments', () => {
    const content = '// TODO: fix this later';
    const commentNode = mockNode('comment', '// TODO: fix this later', []);
    const root = mockNode('program', content, [commentNode]);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'todo-fixme');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('low');
    expect(match!.category).toBe('cleanup');
    expect(match!.message).toContain('TODO');
  });

  it('detects FIXME and HACK comments', () => {
    const content = '// FIXME: broken\n// HACK: workaround';
    const nodes = [
      mockNode('comment', '// FIXME: broken', []),
      mockNode('comment', '// HACK: workaround', []),
    ];
    const root = mockNode('program', content, nodes);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const matches = findings.filter(f => f.patternId === 'todo-fixme');
    expect(matches.length).toBe(2);
  });

  it('works for Python comments', () => {
    const content = '# TODO: implement this';
    const commentNode = mockNode('comment', '# TODO: implement this', []);
    const root = mockNode('program', content, [commentNode]);
    const findings = scanPatterns(root, 'Python', content, patterns);
    const match = findings.find(f => f.patternId === 'todo-fixme');
    expect(match).toBeDefined();
  });
});

describe('deeply-nested pattern', () => {
  const patterns = getPatterns();

  it('detects deeply indented code (>= 8 indent levels)', () => {
    const indent = ' '.repeat(16); // 8 levels of 2-space indent
    const content = `function foo() {\n  if (true) {\n    if (true) {\n      if (true) {\n${indent}doSomething();\n      }\n    }\n  }\n}`;
    const root = mockNode('program', content, []);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'deeply-nested');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('medium');
    expect(match!.category).toBe('refactor');
  });

  it('does NOT trigger for moderately nested code', () => {
    const content = `function foo() {\n  if (true) {\n    doSomething();\n  }\n}`;
    const root = mockNode('program', content, []);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'deeply-nested');
    expect(match).toBeUndefined();
  });
});

describe('non-null-assertion-heavy pattern', () => {
  const patterns = getPatterns();

  it('does NOT trigger with 5 or fewer non-null assertions', () => {
    const nodes = Array.from({ length: 5 }, () =>
      mockNode('non_null_expression', 'foo!', []),
    );
    const root = mockNode('program', 'code', nodes);
    const findings = scanPatterns(root, 'TypeScript', 'code', patterns);
    const match = findings.find(f => f.patternId === 'non-null-assertion-heavy');
    expect(match).toBeUndefined();
  });

  it('triggers with more than 5 non-null assertions', () => {
    const nodes = Array.from({ length: 8 }, () =>
      mockNode('non_null_expression', 'foo!', []),
    );
    const root = mockNode('program', 'code', nodes);
    const findings = scanPatterns(root, 'TypeScript', 'code', patterns);
    const match = findings.find(f => f.patternId === 'non-null-assertion-heavy');
    expect(match).toBeDefined();
    expect(match!.message).toContain('8');
    expect(match!.category).toBe('types');
  });
});

describe('unreachable-code pattern', () => {
  const patterns = getPatterns();

  it('detects code after return statement', () => {
    const returnStmt = mockNode('return_statement', 'return 1', []);
    returnStmt.isNamed = () => true;
    const deadCode = mockNode('expression_statement', 'console.log("dead")', []);
    deadCode.isNamed = () => true;
    const block = mockNode('statement_block', '{ return 1; console.log("dead"); }', [returnStmt, deadCode]);
    const content = '{ return 1; console.log("dead"); }';
    const root = mockNode('program', content, [block]);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'unreachable-code');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('medium');
    expect(match!.category).toBe('fix');
    expect(match!.message).toContain('return');
  });

  it('detects code after throw statement', () => {
    const throwStmt = mockNode('throw_statement', 'throw new Error()', []);
    throwStmt.isNamed = () => true;
    const deadCode = mockNode('expression_statement', 'cleanup()', []);
    deadCode.isNamed = () => true;
    const block = mockNode('statement_block', '{ throw new Error(); cleanup(); }', [throwStmt, deadCode]);
    const content = '{ throw new Error(); cleanup(); }';
    const root = mockNode('program', content, [block]);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'unreachable-code');
    expect(match).toBeDefined();
    expect(match!.message).toContain('throw');
  });

  it('does NOT trigger when return is last statement', () => {
    const stmt = mockNode('expression_statement', 'doStuff()', []);
    stmt.isNamed = () => true;
    const returnStmt = mockNode('return_statement', 'return 1', []);
    returnStmt.isNamed = () => true;
    const block = mockNode('statement_block', '{ doStuff(); return 1; }', [stmt, returnStmt]);
    const content = '{ doStuff(); return 1; }';
    const root = mockNode('program', content, [block]);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'unreachable-code');
    expect(match).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Symbol-scoped patterns (2.2)
// ---------------------------------------------------------------------------

describe('symbol-scoped pattern attribution', () => {
  const patterns = getPatterns();

  it('empty-catch attributes finding to enclosing function', () => {
    const content = 'function handleLogin() {\n  try {\n    // something\n  } catch (e) {}\n}';
    const catchNode = mockNode('catch_clause', 'catch (e) {}', []);
    const root = mockNode('program', content, [catchNode]);
    const symbols = [
      { name: 'handleLogin', kind: 'function' as const, startLine: 1, endLine: 5 },
    ];
    const findings = scanPatterns(root, 'TypeScript', content, patterns, symbols);
    const match = findings.find(f => f.patternId === 'empty-catch');
    expect(match).toBeDefined();
    expect(match!.symbolName).toBe('handleLogin');
    expect(match!.symbolKind).toBe('function');
    expect(match!.message).toContain('handleLogin');
  });

  it('empty-catch without symbols has no symbolName', () => {
    const content = 'function handleLogin() {\n  try {\n    // something\n  } catch (e) {}\n}';
    const catchNode = mockNode('catch_clause', 'catch (e) {}', []);
    const root = mockNode('program', content, [catchNode]);
    const findings = scanPatterns(root, 'TypeScript', content, patterns);
    const match = findings.find(f => f.patternId === 'empty-catch');
    expect(match).toBeDefined();
    expect(match!.symbolName).toBeUndefined();
  });

  it('large-function uses SymbolRange when available', () => {
    // A 60-line function symbol
    const symbols = [
      { name: 'bigFunction', kind: 'function' as const, startLine: 1, endLine: 60 },
      { name: 'smallFunction', kind: 'function' as const, startLine: 65, endLine: 75 },
    ];
    const root = mockNode('program', '', []);
    const findings = scanPatterns(root, 'TypeScript', '', patterns, symbols);
    const match = findings.find(f => f.patternId === 'large-function');
    expect(match).toBeDefined();
    expect(match!.symbolName).toBe('bigFunction');
    expect(match!.message).toContain('bigFunction');
    expect(match!.message).toContain('60 lines');
    // Small function should NOT be flagged
    expect(findings.filter(f => f.patternId === 'large-function').length).toBe(1);
  });

  it('bare-except attributes to enclosing function', () => {
    const content = 'def process():\n    try:\n        pass\n    except:\n        pass';
    const exceptNode = mockNode('except_clause', 'except:\n        pass', []);
    const root = mockNode('program', content, [exceptNode]);
    const symbols = [
      { name: 'process', kind: 'function' as const, startLine: 1, endLine: 5 },
    ];
    const findings = scanPatterns(root, 'Python', content, patterns, symbols);
    const match = findings.find(f => f.patternId === 'bare-except');
    expect(match).toBeDefined();
    expect(match!.symbolName).toBe('process');
    expect(match!.message).toContain('process');
  });

  it('scanPatterns passes symbols through to patterns', () => {
    // Verify the optional symbols parameter works without breaking existing behavior
    const root = mockNode('program', 'const x = 1;', []);
    const findings = scanPatterns(root, 'TypeScript', 'const x = 1;', patterns, []);
    expect(findings).toEqual([]);
  });
});
