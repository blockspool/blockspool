/**
 * Formulas — typed, versioned, testable sweep recipes.
 *
 * Pure definitions (BUILTIN_FORMULAS, YAML parsing) live in
 * @promptwheel/core/formulas/shared. This file wraps them with
 * filesystem I/O and adds MCP-specific formula application logic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionConfig } from './types.js';
import {
  type Formula as CoreFormula,
  BUILTIN_FORMULAS as CORE_BUILTINS,
  parseSimpleYaml,
  parseStringList,
} from '@promptwheel/core/formulas/shared';

// Re-export core types and constants
export type { Formula } from '@promptwheel/core/formulas/shared';
export { BUILTIN_FORMULAS, parseSimpleYaml, parseStringList } from '@promptwheel/core/formulas/shared';

// Use core's Formula type locally
type Formula = CoreFormula;
interface FormulaPathContext {
  repoRoot: string;
  formulasDir: string;
}

const SAFE_FORMULA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// ---------------------------------------------------------------------------
// Loader (wraps core with filesystem I/O)
// ---------------------------------------------------------------------------

/**
 * Load a formula by name.
 * Search order: user formulas in `.promptwheel/formulas/`, then built-ins.
 */
export function loadFormula(name: string, projectPath?: string): Formula | null {
  if (!isSafeFormulaName(name)) {
    console.warn(`[promptwheel] rejected unsafe formula name: ${name}`);
    return null;
  }
  const userFormula = loadUserFormula(name, projectPath);
  if (userFormula) return userFormula;
  return CORE_BUILTINS.find(f => f.name === name) ?? null;
}

/**
 * List all available formulas (user + built-in, user overrides built-in).
 */
export function listFormulas(projectPath?: string): Formula[] {
  const userFormulas = loadAllUserFormulas(projectPath);
  const userNames = new Set(userFormulas.map(f => f.name));
  const builtins = CORE_BUILTINS.filter(f => !userNames.has(f.name));
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
    min_confidence: config.min_confidence ?? (formula.min_confidence ?? formula.minConfidence),
    max_prs: config.max_prs ?? (formula.max_prs ?? formula.maxPrs),
    formula: config.formula,
  };
}

// ---------------------------------------------------------------------------
// User formulas (filesystem I/O)
// ---------------------------------------------------------------------------

function getFormulasDir(projectPath?: string): FormulaPathContext | null {
  const repoRoot = resolveCanonicalPath(projectPath ?? process.cwd());
  const resolvedFormulasDir = path.resolve(repoRoot, '.promptwheel', 'formulas');
  if (!isPathWithinRoot(resolvedFormulasDir, repoRoot)) return null;

  if (!fs.existsSync(resolvedFormulasDir)) {
    return { repoRoot, formulasDir: resolvedFormulasDir };
  }

  const canonicalFormulasDir = resolveCanonicalPath(resolvedFormulasDir);
  if (!isPathWithinRoot(canonicalFormulasDir, repoRoot)) {
    console.warn(`[promptwheel] rejected formulas directory outside repo root: ${canonicalFormulasDir}`);
    return null;
  }

  return { repoRoot, formulasDir: canonicalFormulasDir };
}

function loadUserFormula(name: string, projectPath?: string): Formula | null {
  const ctx = getFormulasDir(projectPath);
  if (!ctx) return null;

  for (const ext of ['.yaml', '.yml']) {
    const filePath = path.resolve(ctx.formulasDir, `${name}${ext}`);
    if (!isPathWithinRoot(filePath, ctx.formulasDir) || !fs.existsSync(filePath)) {
      continue;
    }

    const canonicalFile = resolveCanonicalPath(filePath);
    if (
      isPathWithinRoot(canonicalFile, ctx.formulasDir) &&
      isPathWithinRoot(canonicalFile, ctx.repoRoot)
    ) {
      return parseFormulaFile(canonicalFile, name);
    }
  }
  return null;
}

function loadAllUserFormulas(projectPath?: string): Formula[] {
  const ctx = getFormulasDir(projectPath);
  if (!ctx || !fs.existsSync(ctx.formulasDir)) return [];

  const files = fs.readdirSync(ctx.formulasDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const formulas: Formula[] = [];
  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    if (!isSafeFormulaName(name)) continue;

    const filePath = path.resolve(ctx.formulasDir, file);
    if (!isPathWithinRoot(filePath, ctx.formulasDir)) continue;

    const canonicalFile = resolveCanonicalPath(filePath);
    if (!isPathWithinRoot(canonicalFile, ctx.formulasDir) || !isPathWithinRoot(canonicalFile, ctx.repoRoot)) {
      continue;
    }

    const formula = parseFormulaFile(canonicalFile, name);
    if (formula) formulas.push(formula);
  }
  return formulas;
}

function parseFormulaFile(filePath: string, name: string): Formula | null {
  const safeInt = (val: string, fallback: number): number => {
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? fallback : n;
  };

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseSimpleYaml(content);

    return {
      name,
      version: parsed.version ? safeInt(parsed.version, 1) : 1,
      description: parsed.description || `Formula: ${name}`,
      scope: parsed.scope,
      categories: parsed.categories ? parseStringList(parsed.categories) : undefined,
      min_confidence: parsed.min_confidence ? safeInt(parsed.min_confidence, 50) : undefined,
      prompt: parsed.prompt,
      max_prs: parsed.max_prs ? safeInt(parsed.max_prs, 5) : undefined,
      model: parsed.model,
      risk_tolerance: parsed.risk_tolerance as Formula['risk_tolerance'],
      exclude: parsed.exclude ? parseStringList(parsed.exclude) : undefined,
      tags: parsed.tags ? parseStringList(parsed.tags) : undefined,
    };
  } catch (err) {
    if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      console.warn(`[promptwheel] failed to parse formula file ${filePath}: ${err.message}`);
    }
    return null;
  }
}

function isSafeFormulaName(name: string): boolean {
  return SAFE_FORMULA_NAME_RE.test(name);
}

function resolveCanonicalPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath).replace(/[\\/]+$/, '');
  const normalizedCandidate = path.resolve(candidatePath).replace(/[\\/]+$/, '');
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(normalizedRoot + path.sep);
}
