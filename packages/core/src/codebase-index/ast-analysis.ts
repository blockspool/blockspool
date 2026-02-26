/**
 * AST-level codebase analysis via @ast-grep/napi.
 *
 * All functions are dependency-injected: they receive the ast-grep module
 * as a parameter so there's no top-level import. This keeps the module
 * loadable even when @ast-grep/napi is not installed.
 *
 * The ast-grep parse() function is synchronous — no async needed.
 */

import type { AstAnalysisResult, ExportEntry, AstFinding } from './shared.js';
import type { AstPattern } from './ast-patterns.js';
import { scanPatterns } from './ast-patterns.js';

// ---------------------------------------------------------------------------
// Types for dependency injection
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the ast-grep/napi module.
 * Avoids importing the actual types so this module works without the dep.
 */
export interface AstGrepModule {
  parse(lang: AstGrepLang, src: string): AstGrepRoot;
  Lang: Record<string, AstGrepLang>;
}

/** Opaque language identifier (the ast-grep Lang enum value). */
export type AstGrepLang = string;

/** Minimal SgRoot interface. */
interface AstGrepRoot {
  root(): AstGrepNode;
}

/** Minimal SgNode interface. */
export interface AstGrepNode {
  kind(): string;
  text(): string;
  children(): AstGrepNode[];
  findAll(rule: { rule: { kind: string } }): AstGrepNode[];
  isNamed(): boolean;
}

// ---------------------------------------------------------------------------
// Language mapping
// ---------------------------------------------------------------------------

/** Map file extension to ast-grep Lang enum key. Returns null for unsupported extensions. */
export function mapExtensionToLang(ext: string): string | null {
  switch (ext) {
    case '.ts': return 'TypeScript';
    case '.tsx': return 'Tsx';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'JavaScript';
    case '.py': return 'Python';
    case '.go': return 'Go';
    case '.rs': return 'Rust';
    case '.java': return 'Java';
    case '.rb': return 'Ruby';
    case '.c': return 'C';
    case '.cpp':
    case '.hpp':
      return 'Cpp';
    case '.cs': return 'CSharp';
    case '.swift': return 'Swift';
    case '.kt':
    case '.kts':
      return 'Kotlin';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a single file using AST parsing. Returns import specifiers,
 * export entries, and cyclomatic complexity.
 *
 * Falls back to null on any parse error (caller should use regex fallback).
 */
export function analyzeFileAst(
  content: string,
  filePath: string,
  langKey: string,
  astGrep: AstGrepModule,
  patterns?: AstPattern[],
): AstAnalysisResult | null {
  try {
    const lang = astGrep.Lang[langKey];
    if (!lang) return null;
    const root = astGrep.parse(lang, content).root();
    const imports = extractImportsAst(root, langKey);
    const exports = extractExportsAst(root, langKey);
    const complexity = estimateCyclomaticComplexity(root, langKey);
    const findings: AstFinding[] | undefined = patterns
      ? scanPatterns(root, langKey, content, patterns) || undefined
      : undefined;
    const result: AstAnalysisResult = { imports, exports, complexity };
    if (findings && findings.length > 0) result.findings = findings;
    return result;
  } catch {
    return null; // parse error — caller falls back to regex
  }
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/** Extract import specifiers from an AST root node. */
export function extractImportsAst(root: AstGrepNode, langKey: string): string[] {
  const imports: string[] = [];

  if (langKey === 'TypeScript' || langKey === 'Tsx' || langKey === 'JavaScript') {
    // JS/TS: import_statement contains string nodes with the specifier
    const importNodes = findAllByKind(root, 'import_statement');
    for (const node of importNodes) {
      const specifier = extractStringLiteral(node);
      if (specifier) imports.push(specifier);
    }
    // Also catch require() calls
    const callNodes = findAllByKind(root, 'call_expression');
    for (const node of callNodes) {
      const text = node.text();
      if (text.startsWith('require(')) {
        const match = text.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        if (match?.[1]) imports.push(match[1]);
      }
    }
  } else if (langKey === 'Python') {
    // import_statement, import_from_statement
    for (const kind of ['import_statement', 'import_from_statement']) {
      const nodes = findAllByKind(root, kind);
      for (const node of nodes) {
        const text = node.text();
        // from X import ... → extract X
        const fromMatch = text.match(/from\s+([\w.]+)\s+import/);
        if (fromMatch?.[1]) { imports.push(fromMatch[1]); continue; }
        // import X → extract X
        const importMatch = text.match(/import\s+([\w.]+)/);
        if (importMatch?.[1]) imports.push(importMatch[1]);
      }
    }
  } else if (langKey === 'Go') {
    const nodes = findAllByKind(root, 'import_spec');
    for (const node of nodes) {
      const specifier = extractStringLiteral(node);
      if (specifier) imports.push(specifier);
    }
    // Also try import_declaration for single imports
    const declNodes = findAllByKind(root, 'import_declaration');
    for (const node of declNodes) {
      const specifier = extractStringLiteral(node);
      if (specifier) imports.push(specifier);
    }
  } else if (langKey === 'Rust') {
    const nodes = findAllByKind(root, 'use_declaration');
    for (const node of nodes) {
      const text = node.text().replace(/^use\s+/, '').replace(/;$/, '').trim();
      if (text) imports.push(text);
    }
  } else if (langKey === 'Java' || langKey === 'Kotlin') {
    const nodes = findAllByKind(root, 'import_declaration');
    for (const node of nodes) {
      const text = node.text().replace(/^import\s+/, '').replace(/^static\s+/, '').replace(/;$/, '').trim();
      if (text) imports.push(text);
    }
  } else if (langKey === 'Ruby') {
    const callNodes = findAllByKind(root, 'call');
    for (const node of callNodes) {
      const text = node.text();
      const match = text.match(/require(?:_relative)?\s+['"]([^'"]+)['"]/);
      if (match?.[1]) imports.push(match[1]);
    }
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/** Extract exported symbols from an AST root node. JS/TS only for now. */
export function extractExportsAst(root: AstGrepNode, langKey: string): ExportEntry[] {
  if (langKey !== 'TypeScript' && langKey !== 'Tsx' && langKey !== 'JavaScript') {
    return [];
  }

  const exports: ExportEntry[] = [];
  const seen = new Set<string>();

  const exportNodes = findAllByKind(root, 'export_statement');
  for (const node of exportNodes) {
    const text = node.text();

    // export default — skip (anonymous)
    if (/^export\s+default\b/.test(text)) {
      if (!seen.has('default')) {
        exports.push({ name: 'default', kind: 'other' });
        seen.add('default');
      }
      continue;
    }

    // export function foo
    const fnMatch = text.match(/export\s+function\s+(\w+)/) ?? text.match(/export\s+async\s+function\s+(\w+)/);
    if (fnMatch?.[1] && !seen.has(fnMatch[1])) {
      exports.push({ name: fnMatch[1], kind: 'function' });
      seen.add(fnMatch[1]);
      continue;
    }

    // export class Foo
    const classMatch = text.match(/export\s+class\s+(\w+)/) ?? text.match(/export\s+abstract\s+class\s+(\w+)/);
    if (classMatch?.[1] && !seen.has(classMatch[1])) {
      exports.push({ name: classMatch[1], kind: 'class' });
      seen.add(classMatch[1]);
      continue;
    }

    // export interface Foo / export type Foo
    const typeMatch = text.match(/export\s+(?:interface|type)\s+(\w+)/);
    if (typeMatch?.[1] && !seen.has(typeMatch[1])) {
      exports.push({ name: typeMatch[1], kind: 'type' });
      seen.add(typeMatch[1]);
      continue;
    }

    // export enum Foo
    const enumMatch = text.match(/export\s+enum\s+(\w+)/) ?? text.match(/export\s+const\s+enum\s+(\w+)/);
    if (enumMatch?.[1] && !seen.has(enumMatch[1])) {
      exports.push({ name: enumMatch[1], kind: 'enum' });
      seen.add(enumMatch[1]);
      continue;
    }

    // export const/let/var foo
    const varMatch = text.match(/export\s+(?:const|let|var)\s+(\w+)/);
    if (varMatch?.[1] && !seen.has(varMatch[1])) {
      exports.push({ name: varMatch[1], kind: 'variable' });
      seen.add(varMatch[1]);
      continue;
    }

    // export { foo, bar } — named re-exports
    const namedMatch = text.match(/export\s*\{([^}]+)\}/);
    if (namedMatch?.[1]) {
      for (const part of namedMatch[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && !seen.has(name)) {
          exports.push({ name, kind: 'other' });
          seen.add(name);
        }
      }
    }
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Cyclomatic complexity
// ---------------------------------------------------------------------------

/** Decision-point node kinds per language family. */
const DECISION_KINDS: Record<string, string[]> = {
  js: [
    'if_statement', 'while_statement', 'for_statement', 'for_in_statement',
    'switch_case', 'catch_clause', 'ternary_expression',
  ],
  python: [
    'if_statement', 'while_statement', 'for_statement',
    'except_clause', 'with_statement',
  ],
  go: [
    'if_statement', 'for_statement', 'select_statement',
    'type_switch_statement', 'communication_case',
  ],
  rust: [
    'if_expression', 'while_expression', 'for_expression',
    'match_arm', 'if_let_expression',
  ],
  java: [
    'if_statement', 'while_statement', 'for_statement',
    'enhanced_for_statement', 'switch_block_statement_group',
    'catch_clause', 'ternary_expression',
  ],
};

export function getLangFamily(langKey: string): string {
  switch (langKey) {
    case 'TypeScript':
    case 'Tsx':
    case 'JavaScript':
      return 'js';
    case 'Python':
      return 'python';
    case 'Go':
      return 'go';
    case 'Rust':
      return 'rust';
    case 'Java':
    case 'Kotlin':
      return 'java';
    default:
      return 'js'; // fallback
  }
}

/**
 * Estimate cyclomatic complexity by counting decision points in the AST.
 * Base complexity is 1 (single path), each decision point adds 1.
 * Also counts && and || in binary expressions as decision points.
 */
export function estimateCyclomaticComplexity(root: AstGrepNode, langKey: string): number {
  const family = getLangFamily(langKey);
  const kinds = DECISION_KINDS[family] ?? DECISION_KINDS.js;

  let complexity = 1; // base path

  for (const kind of kinds) {
    complexity += findAllByKind(root, kind).length;
  }

  // Count logical operators (&&, ||) as additional decision points
  const binaryNodes = findAllByKind(root, 'binary_expression');
  for (const node of binaryNodes) {
    const text = node.text();
    // Only count top-level operator, not nested ones
    if (text.includes('&&') || text.includes('||')) {
      complexity++;
    }
  }

  return complexity;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find all descendant nodes of a given kind using tree traversal. */
export function findAllByKind(root: AstGrepNode, kind: string): AstGrepNode[] {
  try {
    return root.findAll({ rule: { kind } });
  } catch {
    // Fallback: manual traversal if findAll doesn't support rule object
    const result: AstGrepNode[] = [];
    const stack: AstGrepNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.kind() === kind) result.push(node);
      try {
        const children = node.children();
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push(children[i]);
        }
      } catch {
        // node.children() not available — skip
      }
    }
    return result;
  }
}

/** Extract the first string literal value from a node's children. */
function extractStringLiteral(node: AstGrepNode): string | null {
  const text = node.text();
  // Match single or double quoted strings
  const match = text.match(/['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}
