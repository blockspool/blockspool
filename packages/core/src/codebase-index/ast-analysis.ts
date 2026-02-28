/**
 * AST-level codebase analysis via @ast-grep/napi.
 *
 * All functions are dependency-injected: they receive the ast-grep module
 * as a parameter so there's no top-level import. This keeps the module
 * loadable even when @ast-grep/napi is not installed.
 *
 * The ast-grep parse() function is synchronous — no async needed.
 */

import type { AstAnalysisResult, ExportEntry, AstFinding, SymbolRange, CallEdge } from './shared.js';
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
  symbols?: SymbolRange[],
): AstAnalysisResult | null {
  try {
    const lang = astGrep.Lang[langKey];
    if (!lang) return null;
    const root = astGrep.parse(lang, content).root();
    const imports = extractImportsAst(root, langKey);
    const exports = extractExportsAst(root, langKey);
    const importedNames = extractImportedNames(root, langKey);
    const complexity = estimateCyclomaticComplexity(root, langKey);
    const findings: AstFinding[] | undefined = patterns
      ? scanPatterns(root, langKey, content, patterns, symbols) || undefined
      : undefined;
    const result: AstAnalysisResult = { imports, exports, complexity };
    if (findings && findings.length > 0) result.findings = findings;
    if (importedNames.length > 0) result.importedNames = importedNames;
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

/**
 * Extract the actual imported binding names from import statements.
 * Unlike extractImportsAst() which returns specifier paths ('./utils'),
 * this returns the local binding names (foo, bar, MyClass) that appear
 * in import destructuring. These match against export names for dead
 * export detection.
 *
 * JS/TS only — other languages return empty array.
 */
export function extractImportedNames(root: AstGrepNode, langKey: string): string[] {
  if (langKey !== 'TypeScript' && langKey !== 'Tsx' && langKey !== 'JavaScript') {
    return [];
  }

  const names: string[] = [];
  const importNodes = findAllByKind(root, 'import_statement');

  for (const node of importNodes) {
    const text = node.text();

    // Named imports: import { foo, bar as baz } from '...'
    const namedMatch = text.match(/\{([^}]+)\}/);
    if (namedMatch) {
      for (const part of namedMatch[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        // "foo as bar" → the original export name is "foo"
        const asMatch = trimmed.match(/(\w+)\s+as\s+\w+/);
        // For dead export detection we need the *original* name, not the alias
        names.push(asMatch ? asMatch[1] : trimmed);
      }
    }

    // Default import: import Foo from '...' → maps to 'default' export
    // Skip — we already skip 'default' in dead export detection

    // Namespace import: import * as ns from '...' → all exports are used
    const nsMatch = text.match(/import\s+\*\s+as\s+\w+\s+from/);
    if (nsMatch) {
      // Mark ALL exports from this module as used — extract the specifier
      // and store a sentinel. We handle this in detectDeadExports by
      // checking against the specifier-to-module mapping.
      const specMatch = text.match(/['"]([^'"]+)['"]/);
      if (specMatch) {
        names.push(`*:${specMatch[1]}`); // sentinel: "all exports from this specifier"
      }
    }
  }

  // Also handle re-exports: export { foo, bar } from './mod'
  const exportNodes = findAllByKind(root, 'export_statement');
  for (const node of exportNodes) {
    const text = node.text();
    // export { X, Y } from '...' — these names are used (re-exported)
    const reExportMatch = text.match(/export\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/);
    if (reExportMatch) {
      for (const part of reExportMatch[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const asMatch = trimmed.match(/(\w+)\s+as\s+\w+/);
        names.push(asMatch ? asMatch[1] : trimmed);
      }
    }
  }

  return names;
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

// ---------------------------------------------------------------------------
// Top-level symbol extraction (for conflict detection)
// ---------------------------------------------------------------------------

/** Node kinds that represent top-level declarations, per language family. */
const TOP_LEVEL_DECL_KINDS: Record<string, Record<string, SymbolRange['kind']>> = {
  js: {
    function_declaration: 'function',
    class_declaration: 'class',
    variable_declaration: 'variable',
    lexical_declaration: 'variable',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    enum_declaration: 'enum',
    export_statement: 'other', // unwrapped below
  },
  python: {
    function_definition: 'function',
    class_definition: 'class',
    assignment: 'variable',
  },
  go: {
    function_declaration: 'function',
    type_declaration: 'type',
    var_declaration: 'variable',
    const_declaration: 'variable',
  },
  rust: {
    function_item: 'function',
    struct_item: 'class',
    enum_item: 'enum',
    impl_item: 'class',
    const_item: 'variable',
    type_alias: 'type',
  },
  java: {
    method_declaration: 'function',
    class_declaration: 'class',
    field_declaration: 'variable',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
  },
};

/**
 * Extract a declaration name from node text using language-specific patterns.
 * Returns the symbol name or null if not identifiable.
 */
/* eslint-disable security/detect-unsafe-regex -- simple patterns on single-line AST text, no ReDoS risk */
function extractDeclName(text: string, kind: string, family: string): string | null {
  if (family === 'js') {
    // Unwrap export: "export function foo" → treat as function_declaration
    if (kind === 'export_statement') {
      // export default — skip, anonymous
      if (/^export\s+default\b/.test(text)) return null;
      // export function foo / export async function foo
      const fnMatch = text.match(/export\s+(?:async\s+)?function\s+(\w+)/);
      if (fnMatch?.[1]) return fnMatch[1];
      // export class Foo / export abstract class Foo
      const classMatch = text.match(/export\s+(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch?.[1]) return classMatch[1];
      // export interface Foo / export type Foo
      const typeMatch = text.match(/export\s+(?:interface|type)\s+(\w+)/);
      if (typeMatch?.[1]) return typeMatch[1];
      // export enum Foo
      const enumMatch = text.match(/export\s+(?:const\s+)?enum\s+(\w+)/);
      if (enumMatch?.[1]) return enumMatch[1];
      // export const/let/var foo
      const varMatch = text.match(/export\s+(?:const|let|var)\s+(\w+)/);
      if (varMatch?.[1]) return varMatch[1];
      return null;
    }
    const fnMatch = text.match(/(?:async\s+)?function\s+(\w+)/);
    if (fnMatch?.[1]) return fnMatch[1];
    const classMatch = text.match(/(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch?.[1]) return classMatch[1];
    const ifaceMatch = text.match(/interface\s+(\w+)/);
    if (ifaceMatch?.[1]) return ifaceMatch[1];
    const typeMatch = text.match(/type\s+(\w+)/);
    if (typeMatch?.[1]) return typeMatch[1];
    const enumMatch = text.match(/(?:const\s+)?enum\s+(\w+)/);
    if (enumMatch?.[1]) return enumMatch[1];
    const varMatch = text.match(/(?:const|let|var)\s+(\w+)/);
    if (varMatch?.[1]) return varMatch[1];
  } else if (family === 'python') {
    if (kind === 'function_definition') {
      const m = text.match(/def\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'class_definition') {
      const m = text.match(/class\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'assignment') {
      const m = text.match(/^(\w+)\s*=/);
      return m?.[1] ?? null;
    }
  } else if (family === 'go') {
    if (kind === 'function_declaration') {
      const m = text.match(/func\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'type_declaration') {
      const m = text.match(/type\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'var_declaration' || kind === 'const_declaration') {
      const m = text.match(/(?:var|const)\s+(\w+)/);
      return m?.[1] ?? null;
    }
  } else if (family === 'rust') {
    if (kind === 'function_item') {
      const m = text.match(/fn\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'struct_item') {
      const m = text.match(/struct\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'enum_item') {
      const m = text.match(/enum\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'impl_item') {
      const m = text.match(/impl(?:\s*<[^>]*>)?\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'const_item') {
      const m = text.match(/const\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'type_alias') {
      const m = text.match(/type\s+(\w+)/);
      return m?.[1] ?? null;
    }
  } else if (family === 'java') {
    if (kind === 'method_declaration') {
      // Java: return_type method_name(params)
      const m = text.match(/\b(\w+)\s*\(/);
      return m?.[1] ?? null;
    }
    if (kind === 'class_declaration') {
      const m = text.match(/class\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'interface_declaration') {
      const m = text.match(/interface\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'enum_declaration') {
      const m = text.match(/enum\s+(\w+)/);
      return m?.[1] ?? null;
    }
    if (kind === 'field_declaration') {
      // Last word before = or ;
      const m = text.match(/(\w+)\s*[=;]/);
      return m?.[1] ?? null;
    }
  }
  return null;
}
/* eslint-enable security/detect-unsafe-regex */

/**
 * Compute 1-based line numbers from a byte offset within source content.
 * Counts newlines up to the given position.
 */
function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Extract top-level symbols (functions, classes, variables, types, etc.)
 * with their line ranges from source code.
 *
 * Unlike extractExportsAst (which only captures exported symbols in JS/TS),
 * this captures ALL top-level declarations — exported or not — since tickets
 * can modify unexported internal functions.
 *
 * Returns null on parse failure (caller falls back to path-based conflict detection).
 */
export function extractTopLevelSymbols(
  content: string,
  langKey: string,
  astGrep: AstGrepModule,
): SymbolRange[] | null {
  try {
    const lang = astGrep.Lang[langKey];
    if (!lang) return null;

    const root = astGrep.parse(lang, content).root();
    const family = getLangFamily(langKey);
    const declKinds = TOP_LEVEL_DECL_KINDS[family];
    if (!declKinds) return null;

    const symbols: SymbolRange[] = [];
    const seen = new Set<string>();

    // Walk only direct children of root (top-level declarations)
    const topChildren = root.children();
    for (const child of topChildren) {
      const nodeKind = child.kind();
      const symbolKind = declKinds[nodeKind];
      if (symbolKind === undefined) continue;

      const text = child.text();
      const name = extractDeclName(text, nodeKind, family);
      if (!name || seen.has(name)) continue;
      seen.add(name);

      // Resolve the actual symbol kind for export_statement wrappers
      let resolvedKind = symbolKind;
      if (nodeKind === 'export_statement') {
        /* eslint-disable security/detect-unsafe-regex -- simple patterns on single-line AST text */
        if (/export\s+(?:async\s+)?function\s/.test(text)) resolvedKind = 'function';
        else if (/export\s+(?:abstract\s+)?class\s/.test(text)) resolvedKind = 'class';
        else if (/export\s+(?:interface|type)\s/.test(text)) resolvedKind = 'type';
        else if (/export\s+(?:const\s+)?enum\s/.test(text)) resolvedKind = 'enum';
        else if (/export\s+(?:const|let|var)\s/.test(text)) resolvedKind = 'variable';
        /* eslint-enable security/detect-unsafe-regex */
      }

      // Compute line ranges from text positions within content
      const startOffset = content.indexOf(text);
      if (startOffset === -1) continue;
      const startLine = offsetToLine(content, startOffset);
      const endLine = offsetToLine(content, startOffset + text.length);

      symbols.push({ name, kind: resolvedKind, startLine, endLine });
    }

    return symbols;
  } catch {
    return null; // parse error — caller falls back to path-based
  }
}

// ---------------------------------------------------------------------------
// Call edge extraction
// ---------------------------------------------------------------------------

/** Max call edges per file to avoid bloating the cache. */
const MAX_CALL_EDGES_PER_FILE = 50;

/**
 * Extract named import bindings from JS/TS import statements.
 * Returns a map: importedName → module specifier.
 *
 * Handles: `import { foo, bar as baz } from './mod'`
 *          `import X from './mod'`
 *          `const { foo } = require('./mod')`
 */
function extractImportBindings(root: AstGrepNode, langKey: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const family = getLangFamily(langKey);
  if (family !== 'js') return bindings;

  const importNodes = findAllByKind(root, 'import_statement');
  for (const node of importNodes) {
    const text = node.text();
    const specMatch = text.match(/['"]([^'"]+)['"]/);
    if (!specMatch) continue;
    const specifier = specMatch[1];

    // Named imports: import { foo, bar as baz } from '...'
    const namedMatch = text.match(/\{([^}]+)\}/);
    if (namedMatch) {
      for (const part of namedMatch[1].split(',')) {
        const trimmed = part.trim();
        // "foo as bar" → bind "bar", "foo" → bind "foo"
        const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
        bindings.set(asMatch ? asMatch[2] : trimmed, specifier);
      }
    }

    // Default import: import Foo from '...'
    const defaultMatch = text.match(/import\s+(\w+)\s+from/);
    if (defaultMatch) {
      bindings.set(defaultMatch[1], specifier);
    }

    // Namespace import: import * as ns from '...'
    const nsMatch = text.match(/import\s+\*\s+as\s+(\w+)\s+from/);
    if (nsMatch) {
      bindings.set(nsMatch[1], specifier);
    }
  }

  return bindings;
}

/**
 * Extract call edges from a parsed AST.
 *
 * For each top-level function symbol, finds call expressions and maps them
 * to either imported symbols (cross-file) or local top-level functions.
 * Returns null on parse failure.
 *
 * JS/TS only for now — other languages return empty array.
 */
export function extractCallEdges(
  content: string,
  langKey: string,
  astGrep: AstGrepModule,
  symbols?: SymbolRange[],
): CallEdge[] | null {
  const family = getLangFamily(langKey);
  if (family !== 'js') return [];

  try {
    const lang = astGrep.Lang[langKey];
    if (!lang) return null;
    const root = astGrep.parse(lang, content).root();

    const importBindings = extractImportBindings(root, langKey);
    const localSymbolNames = new Set(symbols?.map(s => s.name) ?? []);
    const edges: CallEdge[] = [];

    // Find all call expressions
    const callNodes = findAllByKind(root, 'call_expression');
    for (const callNode of callNodes) {
      if (edges.length >= MAX_CALL_EDGES_PER_FILE) break;

      const callText = callNode.text();
      // Extract the function name being called
      // Handles: foo(), bar.baz(), ns.func()
      let callee: string | null = null;

      // Method call: obj.method(...)
      const methodMatch = callText.match(/^(\w+)\.(\w+)\s*\(/);
      if (methodMatch) {
        const obj = methodMatch[1];
        const method = methodMatch[2];
        // Check if obj is a namespace import
        if (importBindings.has(obj)) {
          callee = method;
          const callLine = offsetToLine(content, content.indexOf(callText));
          const caller = findEnclosingFunction(callLine, symbols);
          if (caller) {
            edges.push({
              caller: caller.name,
              callee,
              line: callLine,
              importSource: importBindings.get(obj),
            });
          }
          continue;
        }
      }

      // Simple call: foo(...)
      const simpleMatch = callText.match(/^(\w+)\s*\(/);
      if (simpleMatch) {
        callee = simpleMatch[1];
        // Skip common globals/builtins
        if (/^(console|Math|JSON|Object|Array|String|Number|Boolean|Date|RegExp|Error|Promise|Set|Map|WeakMap|WeakSet|Symbol|setTimeout|setInterval|clearTimeout|clearInterval|parseInt|parseFloat|require|import)$/.test(callee)) {
          continue;
        }

        const callLine = offsetToLine(content, content.indexOf(callText));
        const caller = findEnclosingFunction(callLine, symbols);
        if (!caller) continue;

        const importSource = importBindings.get(callee);
        if (importSource || localSymbolNames.has(callee)) {
          edges.push({
            caller: caller.name,
            callee,
            line: callLine,
            ...(importSource ? { importSource } : {}),
          });
        }
      }
    }

    return edges;
  } catch {
    return null;
  }
}

/** Find the enclosing function symbol for a given line. */
function findEnclosingFunction(line: number, symbols?: SymbolRange[]): SymbolRange | undefined {
  if (!symbols?.length) return undefined;
  return symbols.find(s =>
    (s.kind === 'function' || s.kind === 'class') &&
    s.startLine <= line && line <= s.endLine
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first string literal value from a node's children. */
function extractStringLiteral(node: AstGrepNode): string | null {
  const text = node.text();
  // Match single or double quoted strings
  const match = text.match(/['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}
