/**
 * Formulas — typed, versioned, testable sweep recipes.
 *
 * A formula configures what a scout session looks for and how strictly
 * it gates execution. Built-in formulas mirror the CLI's set; users can
 * add custom formulas in `.blockspool/formulas/` as simple YAML files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionConfig } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Formula {
  name: string;
  version: number;
  description: string;
  scope?: string;
  categories?: string[];
  min_confidence?: number;
  prompt?: string;
  max_prs?: number;
  model?: string;
  risk_tolerance?: 'low' | 'medium' | 'high';
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Built-in Formulas
// ---------------------------------------------------------------------------

export const BUILTIN_FORMULAS: Formula[] = [
  {
    name: 'security-audit',
    version: 1,
    description: 'Find and fix security vulnerabilities',
    categories: ['security'],
    min_confidence: 80,
    risk_tolerance: 'low',
    prompt: [
      'Look for OWASP Top 10 vulnerabilities, insecure defaults,',
      'missing input validation, credential exposure, and injection risks.',
      'Focus on real vulnerabilities, not style issues.',
    ].join(' '),
    max_prs: 10,
    tags: ['security'],
  },
  {
    name: 'test-coverage',
    version: 1,
    description: 'Add missing unit tests for untested code',
    categories: ['test'],
    min_confidence: 70,
    risk_tolerance: 'medium',
    prompt: [
      'Find functions and modules with no test coverage.',
      'Write focused unit tests with edge cases.',
      'Prioritize business logic over utility functions.',
    ].join(' '),
    max_prs: 15,
    tags: ['quality'],
  },
  {
    name: 'type-safety',
    version: 1,
    description: 'Strengthen TypeScript types and remove any/unknown',
    categories: ['types'],
    min_confidence: 75,
    risk_tolerance: 'medium',
    prompt: [
      'Find uses of any, unknown, or weak typing.',
      'Add proper type annotations, interfaces, and type guards.',
      'Do not change runtime behavior.',
    ].join(' '),
    max_prs: 10,
    tags: ['quality'],
  },
  {
    name: 'cleanup',
    version: 1,
    description: 'Remove dead code, unused imports, and stale comments',
    categories: ['refactor'],
    min_confidence: 85,
    risk_tolerance: 'low',
    prompt: [
      'Find dead code, unused imports, unreachable branches,',
      'commented-out code, and stale TODO comments.',
      'Only remove things that are clearly unused.',
    ].join(' '),
    max_prs: 10,
    tags: ['cleanup'],
  },
  {
    name: 'deep',
    version: 1,
    description: 'Find high-impact structural and architectural improvements',
    categories: ['refactor', 'perf', 'security'],
    min_confidence: 60,
    risk_tolerance: 'high',
    model: 'opus',
    max_prs: 5,
    prompt: [
      'Principal engineer architecture review. Ignore trivial issues.',
      'Focus on: leaky abstractions, silent error swallowing, coupling/circular deps,',
      'mixed concerns (business logic + I/O), algorithmic perf issues,',
      'missing security boundaries, brittle integration points.',
      'Prefer moderate/complex complexity. Set impact_score 1-10.',
    ].join(' '),
    tags: ['architecture', 'deep'],
  },
  {
    name: 'docs',
    version: 1,
    description: 'Add or improve documentation for public APIs',
    categories: ['docs'],
    min_confidence: 70,
    risk_tolerance: 'medium',
    prompt: [
      'Find exported functions, classes, and types missing JSDoc.',
      'Add clear, concise documentation that explains the purpose,',
      'parameters, and return values. Do not over-document obvious code.',
    ].join(' '),
    max_prs: 10,
    tags: ['docs'],
  },
];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load a formula by name.
 * Search order: user formulas in `.blockspool/formulas/`, then built-ins.
 */
export function loadFormula(name: string, projectPath?: string): Formula | null {
  const userFormula = loadUserFormula(name, projectPath);
  if (userFormula) return userFormula;
  return BUILTIN_FORMULAS.find(f => f.name === name) ?? null;
}

/**
 * List all available formulas (user + built-in, user overrides built-in).
 */
export function listFormulas(projectPath?: string): Formula[] {
  const userFormulas = loadAllUserFormulas(projectPath);
  const userNames = new Set(userFormulas.map(f => f.name));
  const builtins = BUILTIN_FORMULAS.filter(f => !userNames.has(f.name));
  return [...userFormulas, ...builtins];
}

/**
 * Apply a formula's settings to a SessionConfig.
 * Formula values are defaults — explicit config values take precedence.
 */
export function applyFormula(formula: Formula, config: SessionConfig): SessionConfig {
  return {
    ...config,
    scope: config.scope ?? formula.scope,
    categories: config.categories ?? formula.categories,
    min_confidence: config.min_confidence ?? formula.min_confidence,
    max_prs: config.max_prs ?? formula.max_prs,
    // formula name stays as-is for prompt injection
    formula: config.formula,
  };
}

// ---------------------------------------------------------------------------
// User formulas (YAML)
// ---------------------------------------------------------------------------

function getFormulasDir(projectPath?: string): string {
  const base = projectPath ?? process.cwd();
  return path.join(base, '.blockspool', 'formulas');
}

function loadUserFormula(name: string, projectPath?: string): Formula | null {
  const dir = getFormulasDir(projectPath);
  for (const ext of ['.yaml', '.yml']) {
    const filePath = path.join(dir, `${name}${ext}`);
    if (fs.existsSync(filePath)) {
      return parseFormulaFile(filePath, name);
    }
  }
  return null;
}

function loadAllUserFormulas(projectPath?: string): Formula[] {
  const dir = getFormulasDir(projectPath);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const formulas: Formula[] = [];
  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    const formula = parseFormulaFile(path.join(dir, file), name);
    if (formula) formulas.push(formula);
  }
  return formulas;
}

function parseFormulaFile(filePath: string, name: string): Formula | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseSimpleYaml(content);

    return {
      name,
      version: parsed.version ? parseInt(parsed.version, 10) : 1,
      description: parsed.description || `Formula: ${name}`,
      scope: parsed.scope,
      categories: parsed.categories ? parseStringList(parsed.categories) : undefined,
      min_confidence: parsed.min_confidence ? parseInt(parsed.min_confidence, 10) : undefined,
      prompt: parsed.prompt,
      max_prs: parsed.max_prs ? parseInt(parsed.max_prs, 10) : undefined,
      model: parsed.model,
      risk_tolerance: parsed.risk_tolerance as Formula['risk_tolerance'],
      tags: parsed.tags ? parseStringList(parsed.tags) : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Simple YAML parser (avoids external dependency)
// ---------------------------------------------------------------------------

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  let currentKey: string | null = null;
  let multilineValue: string[] = [];
  let multilineIndent = 0;

  for (const line of lines) {
    if (!currentKey && (line.trim().startsWith('#') || line.trim() === '')) continue;

    if (currentKey) {
      const indent = line.length - line.trimStart().length;
      if (indent > multilineIndent && line.trim() !== '') {
        multilineValue.push(line.trim());
        continue;
      } else {
        result[currentKey] = multilineValue.join(' ');
        currentKey = null;
        multilineValue = [];
      }
    }

    const match = line.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
    if (match) {
      const [, key, value] = match;
      const trimmedValue = value.trim();

      if (trimmedValue === '|' || trimmedValue === '>') {
        currentKey = key;
        multilineIndent = line.length - line.trimStart().length;
        multilineValue = [];
      } else {
        result[key] = trimmedValue;
      }
    }
  }

  if (currentKey) {
    result[currentKey] = multilineValue.join(' ');
  }

  return result;
}

function parseStringList(value: string): string[] {
  const stripped = value.replace(/^\[/, '').replace(/\]$/, '');
  return stripped.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
