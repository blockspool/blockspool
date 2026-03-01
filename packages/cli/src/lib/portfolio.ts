/**
 * Persistent Project Portfolio — cross-session context about a project's
 * architecture, hotspots, decisions, and patterns.
 *
 * Stored in `.promptwheel/portfolio.json` — human-readable, version-controlled.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPromptwheelDir } from './solo-config.js';

export interface ProjectPortfolio {
  version: 1;
  lastUpdated: string;
  architecture: {
    entryPoints: string[];
    coreModules: string[];
    testStrategy: string;
    buildSystem: string;
  };
  hotspots: Array<{
    path: string;
    failureCount: number;
    lastFailure: string;
    commonErrors: string[];
  }>;
  decisions: Array<{
    date: string;
    summary: string;
    category: string;
  }>;
  patterns: {
    avgStepsPerTrajectory: number;
    preferredCategories: string[];
    avoidCategories: string[];
    successRateByScope: Record<string, number>;
  };
}

/**
 * Load existing portfolio from disk, or return null.
 */
export function loadPortfolio(repoRoot: string): ProjectPortfolio | null {
  const portfolioPath = path.join(getPromptwheelDir(repoRoot), 'portfolio.json');
  if (!fs.existsSync(portfolioPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(portfolioPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save portfolio to disk.
 */
export function savePortfolio(repoRoot: string, portfolio: ProjectPortfolio): void {
  const dir = getPromptwheelDir(repoRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const portfolioPath = path.join(dir, 'portfolio.json');
  const tmp = portfolioPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(portfolio, null, 2));
  fs.renameSync(tmp, portfolioPath);
}

/**
 * Detect build system from repo root.
 */
function detectBuildSystem(repoRoot: string): string {
  if (fs.existsSync(path.join(repoRoot, 'Cargo.toml'))) return 'cargo';
  if (fs.existsSync(path.join(repoRoot, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(repoRoot, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(repoRoot, 'bun.lockb')) || fs.existsSync(path.join(repoRoot, 'bun.lock'))) return 'bun';
  if (fs.existsSync(path.join(repoRoot, 'package.json'))) return 'npm';
  if (fs.existsSync(path.join(repoRoot, 'pyproject.toml')) || fs.existsSync(path.join(repoRoot, 'setup.py'))) return 'python';
  return 'unknown';
}

/**
 * Detect test strategy from repo root.
 */
function detectTestStrategy(repoRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };
    if (deps.vitest) return 'vitest';
    if (deps.jest) return 'jest';
    if (deps.mocha) return 'mocha';
  } catch { /* not a node project */ }
  if (fs.existsSync(path.join(repoRoot, 'pytest.ini')) || fs.existsSync(path.join(repoRoot, 'pyproject.toml'))) return 'pytest';
  if (fs.existsSync(path.join(repoRoot, 'Cargo.toml'))) return 'cargo-test';
  return 'unknown';
}

// Type for drill history entries (import or define inline)
interface DrillHistoryLike {
  name: string;
  description: string;
  stepsTotal: number;
  stepsCompleted: number;
  stepsFailed: number;
  outcome: 'completed' | 'stalled';
  completionPct: number;
  categories: string[];
  scopes: string[];
  timestamp?: number;
  failedSteps?: Array<{ id: string; title: string; reason?: string }>;
  modifiedFiles?: string[];
}

// Type for learnings
interface LearningLike {
  id: string;
  text: string;
  category: string;
  source?: { type: string; detail?: string };
  tags?: string[];
}

// Type for codebase index (simplified)
interface CodebaseIndexLike {
  modules?: Array<{ path: string; [key: string]: any }>;
  graph_metrics?: { hub_modules?: string[] };
  [key: string]: any;
}

/**
 * Build or update the project portfolio from available data sources.
 */
export function buildOrUpdatePortfolio(
  repoRoot: string,
  codebaseIndex: CodebaseIndexLike | null,
  drillHistory: DrillHistoryLike[],
  learnings: LearningLike[],
): ProjectPortfolio {
  const existing = loadPortfolio(repoRoot);

  // Architecture detection
  const architecture = {
    entryPoints: codebaseIndex?.modules?.slice(0, 5).map(m => m.path) ?? existing?.architecture?.entryPoints ?? [],
    coreModules: codebaseIndex?.graph_metrics?.hub_modules?.slice(0, 10) ?? existing?.architecture?.coreModules ?? [],
    testStrategy: detectTestStrategy(repoRoot),
    buildSystem: detectBuildSystem(repoRoot),
  };

  // Hotspot aggregation from drill history failures
  const hotspotMap = new Map<string, { failureCount: number; lastFailure: string; errors: Set<string> }>();

  // Seed from existing portfolio
  if (existing?.hotspots) {
    for (const h of existing.hotspots) {
      hotspotMap.set(h.path, {
        failureCount: h.failureCount,
        lastFailure: h.lastFailure,
        errors: new Set(h.commonErrors),
      });
    }
  }

  // Add from drill history
  for (const entry of drillHistory) {
    if (entry.outcome !== 'stalled') continue;
    const timestamp = entry.timestamp ? new Date(entry.timestamp).toISOString() : new Date().toISOString();
    for (const scope of entry.scopes) {
      const prev = hotspotMap.get(scope);
      if (prev) {
        prev.failureCount++;
        prev.lastFailure = timestamp;
        if (entry.failedSteps) {
          for (const s of entry.failedSteps) {
            if (s.reason) prev.errors.add(s.reason.slice(0, 100));
          }
        }
      } else {
        const errors = new Set<string>();
        if (entry.failedSteps) {
          for (const s of entry.failedSteps) {
            if (s.reason) errors.add(s.reason.slice(0, 100));
          }
        }
        hotspotMap.set(scope, { failureCount: 1, lastFailure: timestamp, errors });
      }
    }
  }

  // Convert to sorted array (most failures first), cap at 20
  const hotspots = [...hotspotMap.entries()]
    .map(([p, h]) => ({
      path: p,
      failureCount: h.failureCount,
      lastFailure: h.lastFailure,
      commonErrors: [...h.errors].slice(0, 5),
    }))
    .sort((a, b) => b.failureCount - a.failureCount)
    .slice(0, 20);

  // Decisions from learnings
  const existingDecisions = existing?.decisions ?? [];
  const newDecisions: ProjectPortfolio['decisions'] = [];
  const existingSummaries = new Set(existingDecisions.map(d => d.summary));

  for (const l of learnings) {
    if (l.source?.type === 'drill_blueprint' || l.tags?.includes('blueprint')) {
      if (!existingSummaries.has(l.text)) {
        newDecisions.push({
          date: new Date().toISOString().split('T')[0],
          summary: l.text,
          category: l.category,
        });
      }
    }
  }

  // Cap decisions at 50 (keep newest)
  const allDecisions = [...existingDecisions, ...newDecisions].slice(-50);

  // Patterns from drill history
  const totalSteps = drillHistory.reduce((sum, h) => sum + h.stepsTotal, 0);
  const avgStepsPerTrajectory = drillHistory.length > 0 ? totalSteps / drillHistory.length : existing?.patterns?.avgStepsPerTrajectory ?? 0;

  // Category success rates
  const catSuccess = new Map<string, { success: number; total: number }>();
  for (const entry of drillHistory) {
    for (const cat of entry.categories) {
      const s = catSuccess.get(cat) ?? { success: 0, total: 0 };
      s.total++;
      if (entry.outcome === 'completed') s.success++;
      catSuccess.set(cat, s);
    }
  }

  const preferredCategories = [...catSuccess.entries()]
    .filter(([, s]) => s.total >= 2 && s.success / s.total >= 0.6)
    .sort((a, b) => (b[1].success / b[1].total) - (a[1].success / a[1].total))
    .map(([c]) => c);

  const avoidCategories = [...catSuccess.entries()]
    .filter(([, s]) => s.total >= 2 && s.success / s.total < 0.3)
    .map(([c]) => c);

  // Scope success rates
  const scopeSuccess = new Map<string, { success: number; total: number }>();
  for (const entry of drillHistory) {
    for (const scope of entry.scopes) {
      const s = scopeSuccess.get(scope) ?? { success: 0, total: 0 };
      s.total++;
      if (entry.outcome === 'completed') s.success++;
      scopeSuccess.set(scope, s);
    }
  }
  const successRateByScope: Record<string, number> = {};
  for (const [scope, s] of scopeSuccess) {
    if (s.total >= 2) {
      successRateByScope[scope] = Math.round((s.success / s.total) * 100) / 100;
    }
  }

  const portfolio: ProjectPortfolio = {
    version: 1,
    lastUpdated: new Date().toISOString(),
    architecture,
    hotspots,
    decisions: allDecisions,
    patterns: {
      avgStepsPerTrajectory: Math.round(avgStepsPerTrajectory * 10) / 10,
      preferredCategories,
      avoidCategories,
      successRateByScope,
    },
  };

  return portfolio;
}

/**
 * Format portfolio summary for scout prompt injection (max ~500 chars).
 */
export function formatPortfolioForPrompt(portfolio: ProjectPortfolio): string {
  const parts: string[] = [];

  if (portfolio.architecture.coreModules.length > 0) {
    parts.push(`Core modules: ${portfolio.architecture.coreModules.slice(0, 5).join(', ')} (high fan-in)`);
  }

  if (portfolio.hotspots.length > 0) {
    const top = portfolio.hotspots.slice(0, 3);
    parts.push(`Hotspots: ${top.map(h => `${h.path} (${h.failureCount} failures)`).join(', ')}`);
  }

  if (portfolio.patterns.preferredCategories.length > 0) {
    const catStr = portfolio.patterns.preferredCategories.slice(0, 3).join(', ');
    const scopeStr = Object.entries(portfolio.patterns.successRateByScope)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([s, r]) => `${s} (${Math.round(r * 100)}%)`)
      .join(', ');
    parts.push(`Patterns: avg ${portfolio.patterns.avgStepsPerTrajectory} steps/trajectory, best categories: ${catStr}${scopeStr ? `, top scopes: ${scopeStr}` : ''}`);
  }

  if (portfolio.patterns.avoidCategories.length > 0) {
    parts.push(`Low success: ${portfolio.patterns.avoidCategories.join(', ')}`);
  }

  const content = parts.join('\n');
  // Cap at 500 chars
  const trimmed = content.length > 500 ? content.slice(0, 497) + '...' : content;

  return `<project-portfolio>\n${trimmed}\n</project-portfolio>`;
}

/**
 * Delete portfolio file.
 */
export function resetPortfolio(repoRoot: string): boolean {
  const portfolioPath = path.join(getPromptwheelDir(repoRoot), 'portfolio.json');
  if (fs.existsSync(portfolioPath)) {
    fs.unlinkSync(portfolioPath);
    return true;
  }
  return false;
}
