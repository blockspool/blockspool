/**
 * Step complexity classifier — routes trajectory steps to appropriate models
 * based on category, scope, and description heuristics.
 */

/** Complexity levels for model routing */
export type StepComplexity = 'simple' | 'moderate' | 'complex';

/** Default model mapping per complexity level */
export const DEFAULT_MODEL_MAP: Record<StepComplexity, string> = {
  simple: 'haiku',
  moderate: 'sonnet',
  complex: 'opus',
};

const SIMPLE_CATEGORIES = new Set(['docs', 'types', 'cleanup', 'test']);
const COMPLEX_CATEGORIES = new Set(['security', 'fix', 'migration']);

/**
 * Classify a trajectory step's complexity based on its properties.
 *
 * Rules:
 * - `simple`: single category in [docs, types, cleanup, test] AND narrow scope (single dir or ≤2 files)
 * - `complex`: categories include [security, fix, migration] OR scope is `**` / multi-module (3+ distinct top-level dirs)
 * - `moderate`: everything else
 */
export function classifyStepComplexity(step: {
  categories?: string[];
  scope?: string;
  description?: string;
  allowed_paths?: string[];
}): StepComplexity {
  const categories = step.categories ?? [];
  const scope = step.scope ?? '';
  const paths = step.allowed_paths ?? [];

  // Check for complex indicators first (they take priority)
  const hasComplexCategory = categories.some(c => COMPLEX_CATEGORIES.has(c));
  const isBroadScope = scope === '**' || scope === '';
  const distinctTopDirs = new Set(paths.map(p => p.split('/')[0]).filter(Boolean));
  const isMultiModule = distinctTopDirs.size >= 3;

  if (hasComplexCategory || (paths.length > 0 && isMultiModule) || (isBroadScope && paths.length === 0 && categories.length > 1)) {
    return 'complex';
  }

  // Check for simple indicators
  const allSimpleCategories = categories.length > 0 && categories.every(c => SIMPLE_CATEGORIES.has(c));
  const isNarrowScope = paths.length <= 2 || (distinctTopDirs.size <= 1 && paths.length > 0);

  if (allSimpleCategories && isNarrowScope) {
    return 'simple';
  }

  return 'moderate';
}

/**
 * Get the recommended model for a step based on its complexity.
 */
export function getModelForStep(
  step: { categories?: string[]; scope?: string; description?: string; allowed_paths?: string[] },
  modelMap?: Partial<Record<StepComplexity, string>>,
): string {
  const complexity = classifyStepComplexity(step);
  const map = { ...DEFAULT_MODEL_MAP, ...modelMap };
  return map[complexity];
}
