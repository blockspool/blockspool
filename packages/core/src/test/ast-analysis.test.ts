/**
 * AST analysis tests — covers functions in codebase-index/ast-analysis.ts:
 *   - mapExtensionToLang
 *   - analyzeFileAst (with mock ast-grep module)
 *   - extractImportsAst
 *   - extractExportsAst
 *   - estimateCyclomaticComplexity
 *   - Graceful degradation when ast-grep unavailable
 */

import { describe, it, expect } from 'vitest';
import {
  mapExtensionToLang,
  analyzeFileAst,
  extractImportsAst,
  extractExportsAst,
  estimateCyclomaticComplexity,
  extractTopLevelSymbols,
  type AstGrepModule,
} from '../codebase-index/ast-analysis.js';

// ---------------------------------------------------------------------------
// Mock ast-grep module — simulates tree-sitter-style AST nodes
// ---------------------------------------------------------------------------

/**
 * Minimal mock node that supports kind(), text(), children(), findAll().
 * The findAll implementation searches descendants by kind to match
 * how ast-grep's rule-based search works.
 */
function mockNode(kind: string, text: string, children: ReturnType<typeof mockNode>[] = []): {
  kind(): string;
  text(): string;
  children(): ReturnType<typeof mockNode>[];
  findAll(rule: { rule: { kind: string } }): ReturnType<typeof mockNode>[];
  isNamed(): boolean;
} {
  const node = {
    kind: () => kind,
    text: () => text,
    children: () => children,
    findAll: (rule: { rule: { kind: string } }) => {
      const results: ReturnType<typeof mockNode>[] = [];
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

function createMockAstGrep(rootNode: ReturnType<typeof mockNode>): AstGrepModule {
  return {
    parse: () => ({ root: () => rootNode }),
    Lang: {
      TypeScript: 'TypeScript',
      JavaScript: 'JavaScript',
      Tsx: 'Tsx',
      Python: 'Python',
      Go: 'Go',
      Rust: 'Rust',
      Java: 'Java',
      Ruby: 'Ruby',
    },
  };
}

// ---------------------------------------------------------------------------
// mapExtensionToLang
// ---------------------------------------------------------------------------

describe('mapExtensionToLang', () => {
  it('maps TypeScript extensions', () => {
    expect(mapExtensionToLang('.ts')).toBe('TypeScript');
    expect(mapExtensionToLang('.tsx')).toBe('Tsx');
  });

  it('maps JavaScript extensions', () => {
    expect(mapExtensionToLang('.js')).toBe('JavaScript');
    expect(mapExtensionToLang('.jsx')).toBe('JavaScript');
    expect(mapExtensionToLang('.mjs')).toBe('JavaScript');
    expect(mapExtensionToLang('.cjs')).toBe('JavaScript');
  });

  it('maps other languages', () => {
    expect(mapExtensionToLang('.py')).toBe('Python');
    expect(mapExtensionToLang('.go')).toBe('Go');
    expect(mapExtensionToLang('.rs')).toBe('Rust');
    expect(mapExtensionToLang('.java')).toBe('Java');
    expect(mapExtensionToLang('.rb')).toBe('Ruby');
    expect(mapExtensionToLang('.c')).toBe('C');
    expect(mapExtensionToLang('.cpp')).toBe('Cpp');
    expect(mapExtensionToLang('.cs')).toBe('CSharp');
    expect(mapExtensionToLang('.swift')).toBe('Swift');
    expect(mapExtensionToLang('.kt')).toBe('Kotlin');
  });

  it('returns null for unsupported extensions', () => {
    expect(mapExtensionToLang('.json')).toBeNull();
    expect(mapExtensionToLang('.yaml')).toBeNull();
    expect(mapExtensionToLang('.md')).toBeNull();
    expect(mapExtensionToLang('.txt')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractImportsAst — JS/TS
// ---------------------------------------------------------------------------

describe('extractImportsAst JS/TS', () => {
  it('extracts import statements', () => {
    const root = mockNode('program', '', [
      mockNode('import_statement', "import { foo } from './bar'"),
      mockNode('import_statement', "import * as path from 'node:path'"),
    ]);
    const imports = extractImportsAst(root, 'TypeScript');
    expect(imports).toContain('./bar');
    expect(imports).toContain('node:path');
  });

  it('extracts require calls', () => {
    const root = mockNode('program', '', [
      mockNode('call_expression', "require('./utils')"),
    ]);
    const imports = extractImportsAst(root, 'JavaScript');
    expect(imports).toContain('./utils');
  });

  it('returns empty for no imports', () => {
    const root = mockNode('program', '', [
      mockNode('function_declaration', 'function hello() {}'),
    ]);
    const imports = extractImportsAst(root, 'TypeScript');
    expect(imports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractImportsAst — Python
// ---------------------------------------------------------------------------

describe('extractImportsAst Python', () => {
  it('extracts from-import statements', () => {
    const root = mockNode('module', '', [
      mockNode('import_from_statement', 'from os.path import join'),
    ]);
    const imports = extractImportsAst(root, 'Python');
    expect(imports).toContain('os.path');
  });

  it('extracts plain import statements', () => {
    const root = mockNode('module', '', [
      mockNode('import_statement', 'import sys'),
    ]);
    const imports = extractImportsAst(root, 'Python');
    expect(imports).toContain('sys');
  });
});

// ---------------------------------------------------------------------------
// extractImportsAst — Go
// ---------------------------------------------------------------------------

describe('extractImportsAst Go', () => {
  it('extracts import specs', () => {
    const root = mockNode('source_file', '', [
      mockNode('import_spec', '"fmt"'),
      mockNode('import_spec', '"github.com/foo/bar"'),
    ]);
    const imports = extractImportsAst(root, 'Go');
    expect(imports).toContain('fmt');
    expect(imports).toContain('github.com/foo/bar');
  });
});

// ---------------------------------------------------------------------------
// extractExportsAst
// ---------------------------------------------------------------------------

describe('extractExportsAst', () => {
  it('extracts function exports', () => {
    const root = mockNode('program', '', [
      mockNode('export_statement', 'export function doThing() {}'),
    ]);
    const exports = extractExportsAst(root, 'TypeScript');
    expect(exports).toEqual([{ name: 'doThing', kind: 'function' }]);
  });

  it('extracts class exports', () => {
    const root = mockNode('program', '', [
      mockNode('export_statement', 'export class MyClass {}'),
    ]);
    const exports = extractExportsAst(root, 'TypeScript');
    expect(exports).toEqual([{ name: 'MyClass', kind: 'class' }]);
  });

  it('extracts type/interface exports', () => {
    const root = mockNode('program', '', [
      mockNode('export_statement', 'export interface Config {}'),
      mockNode('export_statement', 'export type Result = string'),
    ]);
    const exports = extractExportsAst(root, 'TypeScript');
    expect(exports).toHaveLength(2);
    const names = exports.map(e => e.name).sort();
    expect(names).toEqual(['Config', 'Result']);
    expect(exports.every(e => e.kind === 'type')).toBe(true);
  });

  it('extracts variable exports', () => {
    const root = mockNode('program', '', [
      mockNode('export_statement', 'export const VERSION = "1.0"'),
    ]);
    const exports = extractExportsAst(root, 'TypeScript');
    expect(exports).toEqual([{ name: 'VERSION', kind: 'variable' }]);
  });

  it('extracts named re-exports', () => {
    const root = mockNode('program', '', [
      mockNode('export_statement', "export { foo, bar as baz } from './lib'"),
    ]);
    const exports = extractExportsAst(root, 'TypeScript');
    expect(exports).toHaveLength(2);
    expect(exports.map(e => e.name)).toContain('foo');
    expect(exports.map(e => e.name)).toContain('baz');
  });

  it('extracts default export', () => {
    const root = mockNode('program', '', [
      mockNode('export_statement', 'export default function main() {}'),
    ]);
    const exports = extractExportsAst(root, 'TypeScript');
    expect(exports).toEqual([{ name: 'default', kind: 'other' }]);
  });

  it('deduplicates exports', () => {
    const root = mockNode('program', '', [
      mockNode('export_statement', 'export function foo() {}'),
      mockNode('export_statement', "export { foo }"),
    ]);
    const exports = extractExportsAst(root, 'TypeScript');
    expect(exports).toHaveLength(1);
    expect(exports[0].name).toBe('foo');
  });

  it('returns empty for non-JS/TS languages', () => {
    const root = mockNode('module', '', []);
    expect(extractExportsAst(root, 'Python')).toEqual([]);
    expect(extractExportsAst(root, 'Go')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// estimateCyclomaticComplexity
// ---------------------------------------------------------------------------

describe('estimateCyclomaticComplexity', () => {
  it('returns 1 for straight-line code', () => {
    const root = mockNode('program', '', [
      mockNode('expression_statement', 'console.log("hello")'),
    ]);
    expect(estimateCyclomaticComplexity(root, 'TypeScript')).toBe(1);
  });

  it('counts if statements', () => {
    const root = mockNode('program', '', [
      mockNode('if_statement', 'if (x) {}'),
      mockNode('if_statement', 'if (y) {}'),
    ]);
    expect(estimateCyclomaticComplexity(root, 'TypeScript')).toBe(3); // 1 + 2
  });

  it('counts various decision points', () => {
    const root = mockNode('program', '', [
      mockNode('if_statement', 'if (x) {}'),
      mockNode('while_statement', 'while (y) {}'),
      mockNode('for_statement', 'for (;;) {}'),
      mockNode('catch_clause', 'catch (e) {}'),
    ]);
    expect(estimateCyclomaticComplexity(root, 'TypeScript')).toBe(5);
  });

  it('counts logical operators as decision points', () => {
    const root = mockNode('program', '', [
      mockNode('binary_expression', 'a && b'),
      mockNode('binary_expression', 'c || d'),
    ]);
    expect(estimateCyclomaticComplexity(root, 'TypeScript')).toBe(3);
  });

  it('uses Python decision kinds for Python code', () => {
    const root = mockNode('module', '', [
      mockNode('if_statement', 'if x:'),
      mockNode('for_statement', 'for i in range(10):'),
      mockNode('except_clause', 'except ValueError:'),
    ]);
    expect(estimateCyclomaticComplexity(root, 'Python')).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// analyzeFileAst — integration
// ---------------------------------------------------------------------------

describe('analyzeFileAst', () => {
  it('returns combined analysis result', () => {
    const root = mockNode('program', '', [
      mockNode('import_statement', "import { x } from './x'"),
      mockNode('export_statement', 'export function hello() {}'),
      mockNode('if_statement', 'if (true) {}'),
    ]);
    const astGrep = createMockAstGrep(root);
    const result = analyzeFileAst('code', 'test.ts', 'TypeScript', astGrep);
    expect(result).not.toBeNull();
    expect(result!.imports).toContain('./x');
    expect(result!.exports).toEqual([{ name: 'hello', kind: 'function' }]);
    expect(result!.complexity).toBe(2); // 1 base + 1 if
  });

  it('returns null for unknown language key', () => {
    const root = mockNode('program', '', []);
    const astGrep = createMockAstGrep(root);
    // Remove the lang from the enum
    const limitedAstGrep = { ...astGrep, Lang: {} };
    const result = analyzeFileAst('code', 'test.zig', 'Zig', limitedAstGrep);
    expect(result).toBeNull();
  });

  it('returns null on parse error', () => {
    const astGrep: AstGrepModule = {
      parse: () => { throw new Error('parse failed'); },
      Lang: { TypeScript: 'TypeScript' },
    };
    const result = analyzeFileAst('bad code', 'test.ts', 'TypeScript', astGrep);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractTopLevelSymbols
// ---------------------------------------------------------------------------

describe('extractTopLevelSymbols JS/TS', () => {
  it('extracts function declarations', () => {
    const content = 'function handleLogin() {}\nfunction handleSignup() {}';
    const root = mockNode('program', content, [
      mockNode('function_declaration', 'function handleLogin() {}'),
      mockNode('function_declaration', 'function handleSignup() {}'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'TypeScript', astGrep);
    expect(symbols).not.toBeNull();
    expect(symbols).toHaveLength(2);
    expect(symbols!.map(s => s.name)).toEqual(['handleLogin', 'handleSignup']);
    expect(symbols!.every(s => s.kind === 'function')).toBe(true);
  });

  it('extracts class declarations', () => {
    const content = 'class AuthService {}';
    const root = mockNode('program', content, [
      mockNode('class_declaration', 'class AuthService {}'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'TypeScript', astGrep);
    expect(symbols).toHaveLength(1);
    expect(symbols![0]).toMatchObject({ name: 'AuthService', kind: 'class' });
  });

  it('extracts variable declarations', () => {
    const content = 'const MAX_RETRIES = 3;\nlet counter = 0;';
    const root = mockNode('program', content, [
      mockNode('lexical_declaration', 'const MAX_RETRIES = 3'),
      mockNode('lexical_declaration', 'let counter = 0'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'TypeScript', astGrep);
    expect(symbols).toHaveLength(2);
    expect(symbols![0]).toMatchObject({ name: 'MAX_RETRIES', kind: 'variable' });
    expect(symbols![1]).toMatchObject({ name: 'counter', kind: 'variable' });
  });

  it('unwraps export statements', () => {
    const content = 'export function doThing() {}\nexport class Widget {}';
    const root = mockNode('program', content, [
      mockNode('export_statement', 'export function doThing() {}'),
      mockNode('export_statement', 'export class Widget {}'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'TypeScript', astGrep);
    expect(symbols).toHaveLength(2);
    expect(symbols![0]).toMatchObject({ name: 'doThing', kind: 'function' });
    expect(symbols![1]).toMatchObject({ name: 'Widget', kind: 'class' });
  });

  it('extracts interface and type declarations', () => {
    const content = 'interface Config {}\ntype Result = string';
    const root = mockNode('program', content, [
      mockNode('interface_declaration', 'interface Config {}'),
      mockNode('type_alias_declaration', 'type Result = string'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'TypeScript', astGrep);
    expect(symbols).toHaveLength(2);
    expect(symbols![0]).toMatchObject({ name: 'Config', kind: 'interface' });
    expect(symbols![1]).toMatchObject({ name: 'Result', kind: 'type' });
  });

  it('extracts enum declarations', () => {
    const content = 'enum Status { Active, Inactive }';
    const root = mockNode('program', content, [
      mockNode('enum_declaration', 'enum Status { Active, Inactive }'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'TypeScript', astGrep);
    expect(symbols).toHaveLength(1);
    expect(symbols![0]).toMatchObject({ name: 'Status', kind: 'enum' });
  });

  it('deduplicates symbols by name', () => {
    const content = 'export function foo() {}';
    const root = mockNode('program', content, [
      mockNode('export_statement', 'export function foo() {}'),
      mockNode('function_declaration', 'function foo() {}'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'TypeScript', astGrep);
    expect(symbols).toHaveLength(1);
  });

  it('includes line range information', () => {
    const content = 'function first() {\n  return 1;\n}\nfunction second() {\n  return 2;\n}';
    const root = mockNode('program', content, [
      mockNode('function_declaration', 'function first() {\n  return 1;\n}'),
      mockNode('function_declaration', 'function second() {\n  return 2;\n}'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'TypeScript', astGrep);
    expect(symbols).toHaveLength(2);
    expect(symbols![0].startLine).toBe(1);
    expect(symbols![0].endLine).toBe(3);
    expect(symbols![1].startLine).toBe(4);
    expect(symbols![1].endLine).toBe(6);
  });
});

describe('extractTopLevelSymbols Python', () => {
  it('extracts function and class definitions', () => {
    const content = 'def handle_login():\n    pass\nclass AuthService:\n    pass';
    const root = mockNode('module', content, [
      mockNode('function_definition', 'def handle_login():\n    pass'),
      mockNode('class_definition', 'class AuthService:\n    pass'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'Python', astGrep);
    expect(symbols).toHaveLength(2);
    expect(symbols![0]).toMatchObject({ name: 'handle_login', kind: 'function' });
    expect(symbols![1]).toMatchObject({ name: 'AuthService', kind: 'class' });
  });

  it('extracts assignments', () => {
    const content = 'MAX_RETRIES = 3';
    const root = mockNode('module', content, [
      mockNode('assignment', 'MAX_RETRIES = 3'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'Python', astGrep);
    expect(symbols).toHaveLength(1);
    expect(symbols![0]).toMatchObject({ name: 'MAX_RETRIES', kind: 'variable' });
  });
});

describe('extractTopLevelSymbols Go', () => {
  it('extracts functions and types', () => {
    const content = 'func HandleLogin() {}\ntype Config struct {}';
    const root = mockNode('source_file', content, [
      mockNode('function_declaration', 'func HandleLogin() {}'),
      mockNode('type_declaration', 'type Config struct {}'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'Go', astGrep);
    expect(symbols).toHaveLength(2);
    expect(symbols![0]).toMatchObject({ name: 'HandleLogin', kind: 'function' });
    expect(symbols![1]).toMatchObject({ name: 'Config', kind: 'type' });
  });
});

describe('extractTopLevelSymbols Rust', () => {
  it('extracts functions and structs', () => {
    const content = 'fn handle_login() {}\nstruct Config {}';
    const root = mockNode('source_file', content, [
      mockNode('function_item', 'fn handle_login() {}'),
      mockNode('struct_item', 'struct Config {}'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'Rust', astGrep);
    expect(symbols).toHaveLength(2);
    expect(symbols![0]).toMatchObject({ name: 'handle_login', kind: 'function' });
    expect(symbols![1]).toMatchObject({ name: 'Config', kind: 'class' });
  });
});

describe('extractTopLevelSymbols edge cases', () => {
  it('returns null for unknown language', () => {
    const root = mockNode('program', '', []);
    const astGrep = createMockAstGrep(root);
    const limitedAstGrep = { ...astGrep, Lang: {} };
    expect(extractTopLevelSymbols('', 'Unknown', limitedAstGrep)).toBeNull();
  });

  it('returns null on parse error', () => {
    const astGrep: AstGrepModule = {
      parse: () => { throw new Error('parse failed'); },
      Lang: { TypeScript: 'TypeScript' },
    };
    expect(extractTopLevelSymbols('bad code', 'TypeScript', astGrep)).toBeNull();
  });

  it('returns empty array for file with no declarations', () => {
    const content = '// just a comment';
    const root = mockNode('program', content, [
      mockNode('comment', '// just a comment'),
    ]);
    const astGrep = createMockAstGrep(root);
    const symbols = extractTopLevelSymbols(content, 'TypeScript', astGrep);
    expect(symbols).toEqual([]);
  });
});
