/**
 * AST pattern scanning — mechanically detect code issues from parsed ASTs.
 *
 * Reuses the AST root already parsed for imports/exports/complexity, so
 * pattern scanning adds zero extra file I/O. Findings are injected into
 * the scout prompt as pre-identified targets.
 */

import type { AstGrepNode } from './ast-analysis.js';
import { findAllByKind, getLangFamily } from './ast-analysis.js';
import type { AstFinding } from './shared.js';

export type { AstFinding } from './shared.js';

/** Bump when patterns change to force re-scan of cached entries. */
export const FINDINGS_VERSION = 1;

// ---------------------------------------------------------------------------
// Pattern interface
// ---------------------------------------------------------------------------

export interface AstPattern {
  id: string;
  langs: string[];           // lang family keys: 'js', 'python', etc.
  scan(root: AstGrepNode, langKey: string, content: string): AstFinding[];
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

/** Max findings per file before early-exit. */
const MAX_FINDINGS_PER_FILE = 30;

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const emptyCatchPattern: AstPattern = {
  id: 'empty-catch',
  langs: ['js'],
  scan(root, _langKey, content) {
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
        findings.push({
          patternId: 'empty-catch',
          message: 'catch clause with empty body',
          line: countLinesBefore(content, text),
          severity: 'medium',
          category: 'fix',
        });
      }
    }
    return findings;
  },
};

const typeAssertionHeavyPattern: AstPattern = {
  id: 'type-assertion-heavy',
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
  langs: ['js', 'python'],
  scan(root, langKey, content) {
    const findings: AstFinding[] = [];
    const family = getLangFamily(langKey);
    const kinds = family === 'python'
      ? ['function_definition']
      : ['function_declaration', 'method_definition', 'arrow_function'];

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
  langs: ['python'],
  scan(root, _langKey, content) {
    const findings: AstFinding[] = [];
    const exceptNodes = findAllByKind(root, 'except_clause');
    for (const node of exceptNodes) {
      const text = node.text();
      if (/^except\s*:/.test(text)) {
        findings.push({
          patternId: 'bare-except',
          message: 'bare except clause — specify an exception type',
          line: countLinesBefore(content, text),
          severity: 'high',
          category: 'fix',
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

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Run matching patterns against an AST root. Filters by lang family,
 * runs each pattern's scan(), and combines findings. Early-exits if
 * findings exceed MAX_FINDINGS_PER_FILE.
 */
export function scanPatterns(
  root: AstGrepNode,
  langKey: string,
  content: string,
  patterns: AstPattern[],
): AstFinding[] {
  const family = getLangFamily(langKey);
  const findings: AstFinding[] = [];

  for (const pattern of patterns) {
    if (!pattern.langs.includes(family)) continue;
    const patternFindings = pattern.scan(root, langKey, content);
    findings.push(...patternFindings);
    if (findings.length >= MAX_FINDINGS_PER_FILE) break;
  }

  return findings.length > 0 ? findings : [];
}
