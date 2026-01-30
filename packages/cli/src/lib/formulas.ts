/**
 * Formulas - User-defined repeatable sweep recipes
 *
 * A formula is a YAML config that defines what an auto run should
 * look for and how to fix it. Formulas live in .blockspool/formulas/
 * and can be invoked with --formula <name>.
 *
 * Example:
 *   blockspool solo auto --formula security-audit
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProposalCategory } from '@blockspool/core/scout';

// =============================================================================
// Types
// =============================================================================

export interface Formula {
  /** Unique name (derived from filename) */
  name: string;

  /** Human-readable description */
  description: string;

  /** Scope glob pattern (e.g., "src/") */
  scope?: string;

  /** Proposal categories to include */
  categories?: ProposalCategory[];

  /** Minimum confidence threshold (0-100) */
  minConfidence?: number;

  /** Custom prompt for the scout — tells the AI what to look for */
  prompt?: string;

  /** Max PRs to create */
  maxPrs?: number;

  /** Max time for the run (e.g., "2h", "30m") */
  maxTime?: string;

  /** Focus areas for guided mode */
  focusAreas?: string[];

  /** Patterns to exclude */
  exclude?: string[];

  /** Whether to use roadmap mode (default: true) */
  useRoadmap?: boolean;

  /** Tags for organizing formulas */
  tags?: string[];

  /** Model to use for scouting */
  model?: 'haiku' | 'sonnet' | 'opus';
}

// =============================================================================
// Built-in Formulas
// =============================================================================

export const BUILTIN_FORMULAS: Formula[] = [
  {
    name: 'security-audit',
    description: 'Find and fix security vulnerabilities',
    categories: ['security' as ProposalCategory],
    minConfidence: 80,
    prompt: [
      'Look for OWASP Top 10 vulnerabilities, insecure defaults,',
      'missing input validation, credential exposure, and injection risks.',
      'Focus on real vulnerabilities, not style issues.',
    ].join(' '),
    maxPrs: 10,
    tags: ['security'],
  },
  {
    name: 'test-coverage',
    description: 'Add missing unit tests for untested code',
    categories: ['test' as ProposalCategory],
    minConfidence: 70,
    prompt: [
      'Find functions and modules with no test coverage.',
      'Write focused unit tests with edge cases.',
      'Prioritize business logic over utility functions.',
    ].join(' '),
    maxPrs: 15,
    tags: ['quality'],
  },
  {
    name: 'type-safety',
    description: 'Strengthen TypeScript types and remove any/unknown',
    categories: ['types' as ProposalCategory],
    minConfidence: 75,
    prompt: [
      'Find uses of any, unknown, or weak typing.',
      'Add proper type annotations, interfaces, and type guards.',
      'Do not change runtime behavior.',
    ].join(' '),
    maxPrs: 10,
    tags: ['quality'],
  },
  {
    name: 'cleanup',
    description: 'Remove dead code, unused imports, and stale comments',
    categories: ['refactor' as ProposalCategory],
    minConfidence: 85,
    prompt: [
      'Find dead code, unused imports, unreachable branches,',
      'commented-out code, and stale TODO comments.',
      'Only remove things that are clearly unused.',
    ].join(' '),
    maxPrs: 10,
    tags: ['cleanup'],
  },
  {
    name: 'deep',
    description: 'Find high-impact structural and architectural improvements',
    categories: ['refactor' as ProposalCategory, 'perf' as ProposalCategory, 'security' as ProposalCategory],
    minConfidence: 60,
    model: 'opus',
    maxPrs: 5,
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
    description: 'Add or improve documentation for public APIs',
    categories: ['docs' as ProposalCategory],
    minConfidence: 70,
    prompt: [
      'Find exported functions, classes, and types missing JSDoc.',
      'Add clear, concise documentation that explains the purpose,',
      'parameters, and return values. Do not over-document obvious code.',
    ].join(' '),
    maxPrs: 10,
    tags: ['docs'],
  },
];

// =============================================================================
// Formula Loader
// =============================================================================

/**
 * Load a formula by name.
 *
 * Search order:
 * 1. .blockspool/formulas/<name>.yaml (or .yml)
 * 2. Built-in formulas
 *
 * @returns The formula, or null if not found
 */
export function loadFormula(name: string, repoPath?: string): Formula | null {
  // Try user-defined formulas first
  const userFormula = loadUserFormula(name, repoPath);
  if (userFormula) return userFormula;

  // Fall back to built-in formulas
  return BUILTIN_FORMULAS.find(f => f.name === name) ?? null;
}

/**
 * List all available formulas (built-in + user-defined)
 */
export function listFormulas(repoPath?: string): Formula[] {
  const userFormulas = loadAllUserFormulas(repoPath);

  // User formulas override built-in ones with the same name
  const userNames = new Set(userFormulas.map(f => f.name));
  const builtins = BUILTIN_FORMULAS.filter(f => !userNames.has(f.name));

  return [...userFormulas, ...builtins];
}

/**
 * Load a user-defined formula from .blockspool/formulas/
 */
function loadUserFormula(name: string, repoPath?: string): Formula | null {
  const dir = getFormulasDir(repoPath);
  if (!dir) return null;

  for (const ext of ['.yaml', '.yml']) {
    const filePath = path.join(dir, `${name}${ext}`);
    if (fs.existsSync(filePath)) {
      return parseFormulaFile(filePath, name);
    }
  }

  return null;
}

/**
 * Load all user-defined formulas
 */
function loadAllUserFormulas(repoPath?: string): Formula[] {
  const dir = getFormulasDir(repoPath);
  if (!dir || !fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const formulas: Formula[] = [];

  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    const formula = parseFormulaFile(path.join(dir, file), name);
    if (formula) formulas.push(formula);
  }

  return formulas;
}

/**
 * Get the formulas directory path
 */
function getFormulasDir(repoPath?: string): string | null {
  const base = repoPath || process.cwd();
  return path.join(base, '.blockspool', 'formulas');
}

/**
 * Parse a YAML formula file.
 * Uses a simple key: value parser to avoid adding a YAML dependency.
 */
function parseFormulaFile(filePath: string, name: string): Formula | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseSimpleYaml(content);

    return {
      name,
      description: parsed.description || `Formula: ${name}`,
      scope: parsed.scope,
      categories: parsed.categories ? parseStringList(parsed.categories) as ProposalCategory[] : undefined,
      minConfidence: parsed.min_confidence ? parseInt(parsed.min_confidence, 10) : undefined,
      prompt: parsed.prompt,
      maxPrs: parsed.max_prs ? parseInt(parsed.max_prs, 10) : undefined,
      maxTime: parsed.max_time,
      focusAreas: parsed.focus_areas ? parseStringList(parsed.focus_areas) : undefined,
      exclude: parsed.exclude ? parseStringList(parsed.exclude) : undefined,
      useRoadmap: parsed.use_roadmap !== undefined ? parsed.use_roadmap === 'true' : undefined,
      tags: parsed.tags ? parseStringList(parsed.tags) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Simple YAML-like parser for flat key: value files.
 * Handles single-line values and multi-line | blocks.
 * Does NOT handle nested objects, anchors, or complex YAML features.
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  let currentKey: string | null = null;
  let multilineValue: string[] = [];
  let multilineIndent = 0;

  for (const line of lines) {
    // Skip comments and empty lines (unless in multiline)
    if (!currentKey && (line.trim().startsWith('#') || line.trim() === '')) continue;

    // Check for multiline continuation
    if (currentKey) {
      const indent = line.length - line.trimStart().length;
      if (indent > multilineIndent && line.trim() !== '') {
        multilineValue.push(line.trim());
        continue;
      } else {
        // End of multiline block
        result[currentKey] = multilineValue.join(' ');
        currentKey = null;
        multilineValue = [];
      }
    }

    // Parse key: value
    const match = line.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
    if (match) {
      const [, key, value] = match;
      const trimmedValue = value.trim();

      if (trimmedValue === '|' || trimmedValue === '>') {
        // Start multiline block
        currentKey = key;
        multilineIndent = line.length - line.trimStart().length;
        multilineValue = [];
      } else {
        result[key] = trimmedValue;
      }
    }
  }

  // Flush remaining multiline
  if (currentKey) {
    result[currentKey] = multilineValue.join(' ');
  }

  return result;
}

/**
 * Parse a YAML-style list string: "[a, b, c]" or "a, b, c" -> ["a", "b", "c"]
 */
function parseStringList(value: string): string[] {
  // Handle YAML array syntax: [a, b, c]
  const stripped = value.replace(/^\[/, '').replace(/\]$/, '');
  return stripped.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Apply a formula's settings to auto options.
 * Formula values override defaults but CLI flags take precedence.
 */
export function applyFormula(
  formula: Formula,
  cliOptions: {
    scope?: string;
    types?: ProposalCategory[];
    minConfidence?: number;
    maxPrs?: number;
    maxTime?: string;
    exclude?: string[];
    noRoadmap?: boolean;
  }
): {
  scope: string;
  types?: ProposalCategory[];
  minConfidence?: number;
  maxPrs?: number;
  maxTime?: string;
  exclude?: string[];
  noRoadmap?: boolean;
  prompt?: string;
  focusAreas?: string[];
} {
  return {
    // CLI flags override formula values
    scope: cliOptions.scope || formula.scope || 'src',
    types: cliOptions.types || formula.categories,
    minConfidence: cliOptions.minConfidence ?? formula.minConfidence,
    maxPrs: cliOptions.maxPrs ?? formula.maxPrs,
    maxTime: cliOptions.maxTime || formula.maxTime,
    exclude: cliOptions.exclude || formula.exclude,
    noRoadmap: cliOptions.noRoadmap ?? (formula.useRoadmap === false ? true : undefined),
    // Formula-only fields (no CLI override)
    prompt: formula.prompt,
    focusAreas: formula.focusAreas,
  };
}
