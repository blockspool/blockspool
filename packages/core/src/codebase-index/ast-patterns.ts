/**
 * AST pattern scanning — mechanically detect code issues from parsed ASTs.
 *
 * Reuses the AST root already parsed for imports/exports/complexity, so
 * pattern scanning adds zero extra file I/O. Findings are injected into
 * the scout prompt as pre-identified targets.
 */

import type { AstGrepNode } from './ast-analysis.js';
import { findAllByKind, getLangFamily } from './ast-analysis.js';
import type { AstFinding, SymbolRange } from './shared.js';

export type { AstFinding } from './shared.js';

/**
 * Global findings version. Bump to force re-scan of ALL cached entries.
 * Prefer bumping individual pattern `version` fields instead — that only
 * re-scans files matching the changed pattern's language.
 */
export const FINDINGS_VERSION = 1;

// ---------------------------------------------------------------------------
// Pattern interface
// ---------------------------------------------------------------------------

export interface AstPattern {
  id: string;
  /** Per-pattern version. Bump to re-scan only files matching this pattern's langs. */
  version: number;
  langs: string[];           // lang family keys: 'js', 'python', etc.
  scan(root: AstGrepNode, langKey: string, content: string, symbols?: SymbolRange[]): AstFinding[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find approximate 1-based line number of a substring within content. */
function countLinesBefore(content: string, substring: string): number | null {
  const idx = content.indexOf(substring);
  if (idx === -1) return null;
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** Find the enclosing symbol for a given 1-based line number. */
function findEnclosingSymbol(line: number | null, symbols?: SymbolRange[]): SymbolRange | undefined {
  if (line === null || !symbols?.length) return undefined;
  return symbols.find(s => s.startLine <= line && line <= s.endLine);
}

/** Annotate a finding with enclosing symbol info. */
function annotateWithSymbol(finding: AstFinding, symbols?: SymbolRange[]): AstFinding {
  const enclosing = findEnclosingSymbol(finding.line, symbols);
  if (enclosing) {
    finding.symbolName = enclosing.name;
    finding.symbolKind = enclosing.kind;
  }
  return finding;
}

/** Max findings per file before early-exit. */
const MAX_FINDINGS_PER_FILE = 30;

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const emptyCatchPattern: AstPattern = {
  id: 'empty-catch',
  version: 1,
  langs: ['js'],
  scan(root, _langKey, content, symbols) {
    const findings: AstFinding[] = [];
    const catchNodes = findAllByKind(root, 'catch_clause');
    for (const node of catchNodes) {
      const text = node.text();
      // Find the body portion (between { and })
      const bodyMatch = text.match(/\{([\s\S]*)\}\s*$/);
      if (!bodyMatch) continue;
      const body = bodyMatch[1].trim();
      // Empty or comment-only body
      // eslint-disable-next-line security/detect-unsafe-regex
      if (body === '' || /^(\/\/[^\n]*\n?\s*)*$/.test(body) || /^\/\*[\s\S]*\*\/\s*$/.test(body)) {
        const line = countLinesBefore(content, text);
        const enclosing = findEnclosingSymbol(line, symbols);
        findings.push({
          patternId: 'empty-catch',
          message: enclosing
            ? `empty catch in ${enclosing.name}()`
            : 'catch clause with empty body',
          line,
          severity: 'medium',
          category: 'fix',
          ...(enclosing ? { symbolName: enclosing.name, symbolKind: enclosing.kind } : {}),
        });
      }
    }
    return findings;
  },
};

const typeAssertionHeavyPattern: AstPattern = {
  id: 'type-assertion-heavy',
  version: 1,
  langs: ['js'],
  scan(root, _langKey, _content) {
    const asNodes = findAllByKind(root, 'as_expression');
    if (asNodes.length > 3) {
      return [{
        patternId: 'type-assertion-heavy',
        message: `${asNodes.length} type assertions (as X) — consider narrowing types instead`,
        line: null,
        severity: 'medium',
        category: 'types',
      }];
    }
    return [];
  },
};

const largeFunctionPattern: AstPattern = {
  id: 'large-function',
  version: 1,
  langs: ['js', 'python'],
  scan(root, langKey, content, symbols) {
    const findings: AstFinding[] = [];
    const family = getLangFamily(langKey);
    const kinds = family === 'python'
      ? ['function_definition']
      : ['function_declaration', 'method_definition', 'arrow_function'];

    // If symbols available, use them directly for size detection (more accurate)
    if (symbols?.length) {
      for (const sym of symbols) {
        if (sym.kind !== 'function') continue;
        const lineCount = sym.endLine - sym.startLine + 1;
        if (lineCount > 50) {
          findings.push({
            patternId: 'large-function',
            message: `function ${sym.name} is ${lineCount} lines — consider splitting`,
            line: sym.startLine,
            severity: 'medium',
            category: 'refactor',
            symbolName: sym.name,
            symbolKind: sym.kind,
          });
        }
        if (findings.length >= MAX_FINDINGS_PER_FILE) return findings;
      }
      return findings;
    }

    // Fallback: AST traversal when no symbol data
    for (const kind of kinds) {
      const nodes = findAllByKind(root, kind);
      for (const node of nodes) {
        const text = node.text();
        const lineCount = text.split('\n').length;
        if (lineCount > 50) {
          // Try to extract function name
          const nameMatch = text.match(/(?:function|def|async\s+function)\s+(\w+)/) ??
            // eslint-disable-next-line security/detect-unsafe-regex
            text.match(/(\w+)\s*[=(]\s*(?:async\s+)?(?:\([^)]*\)|[^=])*=>/);
          const name = nameMatch?.[1] ?? '(anonymous)';
          findings.push({
            patternId: 'large-function',
            message: `function ${name} is ${lineCount} lines — consider splitting`,
            line: countLinesBefore(content, text.slice(0, 40)),
            severity: 'medium',
            category: 'refactor',
          });
        }
        if (findings.length >= MAX_FINDINGS_PER_FILE) return findings;
      }
    }
    return findings;
  },
};

const anyAnnotationPattern: AstPattern = {
  id: 'any-annotation',
  version: 1,
  langs: ['js'],
  scan(root, _langKey, _content) {
    const predefinedNodes = findAllByKind(root, 'predefined_type');
    let anyCount = 0;
    for (const node of predefinedNodes) {
      if (node.text() === 'any') anyCount++;
    }
    if (anyCount > 3) {
      return [{
        patternId: 'any-annotation',
        message: `${anyCount} explicit \`any\` type annotations — consider using specific types`,
        line: null,
        severity: 'medium',
        category: 'types',
      }];
    }
    return [];
  },
};

const bareExceptPattern: AstPattern = {
  id: 'bare-except',
  version: 1,
  langs: ['python'],
  scan(root, _langKey, content, symbols) {
    const findings: AstFinding[] = [];
    const exceptNodes = findAllByKind(root, 'except_clause');
    for (const node of exceptNodes) {
      const text = node.text();
      if (/^except\s*:/.test(text)) {
        const line = countLinesBefore(content, text);
        const enclosing = findEnclosingSymbol(line, symbols);
        findings.push({
          patternId: 'bare-except',
          message: enclosing
            ? `bare except in ${enclosing.name}() — specify an exception type`
            : 'bare except clause — specify an exception type',
          line,
          severity: 'high',
          category: 'fix',
          ...(enclosing ? { symbolName: enclosing.name, symbolKind: enclosing.kind } : {}),
        });
      }
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PATTERNS: AstPattern[] = [
  emptyCatchPattern,
  typeAssertionHeavyPattern,
  largeFunctionPattern,
  anyAnnotationPattern,
  bareExceptPattern,
];

/** Return all registered AST patterns. */
export function getPatterns(): AstPattern[] {
  return PATTERNS;
}

/**
 * Compute per-pattern version map: `{ patternId: version }`.
 * Used by the cache to determine which patterns have changed since last scan.
 */
export function getPatternVersions(): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const p of PATTERNS) {
    versions[p.id] = p.version;
  }
  return versions;
}

/**
 * Check if a cached entry's pattern versions are current for the given language.
 * Returns true if all patterns applicable to `langFamily` have matching versions.
 * Missing entries (new patterns added since cache) return false.
 */
export function arePatternVersionsCurrent(
  cachedVersions: Record<string, number> | undefined,
  langFamily: string,
): boolean {
  if (!cachedVersions) return false;
  for (const p of PATTERNS) {
    if (!p.langs.includes(langFamily)) continue;
    if (cachedVersions[p.id] !== p.version) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Run matching patterns against an AST root. Filters by lang family,
 * runs each pattern's scan(), and combines findings. Early-exits if
 * findings exceed MAX_FINDINGS_PER_FILE.
 *
 * When `symbols` are provided (from the AST cache), patterns can attribute
 * findings to specific functions/classes for more actionable output.
 */
export function scanPatterns(
  root: AstGrepNode,
  langKey: string,
  content: string,
  patterns: AstPattern[],
  symbols?: SymbolRange[],
): AstFinding[] {
  const family = getLangFamily(langKey);
  const findings: AstFinding[] = [];

  for (const pattern of patterns) {
    if (!pattern.langs.includes(family)) continue;
    const patternFindings = pattern.scan(root, langKey, content, symbols);
    findings.push(...patternFindings);
    if (findings.length >= MAX_FINDINGS_PER_FILE) break;
  }

  return findings.length > 0 ? findings : [];
}
