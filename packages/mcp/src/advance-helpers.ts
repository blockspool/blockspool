import * as fs from 'node:fs';
import * as path from 'node:path';
import { RunManager } from './run-manager.js';
import { getRegistry } from './tool-registry.js';
import {
  selectRelevant,
  formatLearningsForPrompt,
  recordAccess,
} from './learnings.js';
import type { AdaptiveRiskAssessment } from '@promptwheel/core/learnings/shared';
import { getIncludedLearningIds } from '@promptwheel/core/learnings/shared';

export { loadTrajectoryData } from '@promptwheel/core/trajectory/io';

export const DEFAULT_LEARNINGS_BUDGET = 2000;

/**
 * Build a learnings block for prompt injection. Tracks injected IDs in state.
 * Uses cached learnings from RunState (loaded at session start) to avoid redundant file I/O.
 */
export function buildLearningsBlock(
  run: RunManager,
  contextPaths: string[],
  contextCommands: string[],
): string {
  const s = run.require();
  if (!s.learnings_enabled) return '';

  // Lazy-load learnings from disk on first use
  run.ensureLearningsLoaded();

  const projectPath = run.rootPath;
  const allLearnings = s.cached_learnings;
  if (allLearnings.length === 0) return '';

  const relevant = selectRelevant(allLearnings, { paths: contextPaths, commands: contextCommands });
  const budget = s.learnings_budget ?? DEFAULT_LEARNINGS_BUDGET;
  const block = formatLearningsForPrompt(relevant, budget);
  if (!block) return '';

  // Track which learnings were injected (using budget-aware ID selection
  // instead of substring matching, which produces false positives when one
  // learning's text is a substring of another's)
  const injectedIds = getIncludedLearningIds(relevant, budget);
  s.injected_learning_ids = [...new Set([...s.injected_learning_ids, ...injectedIds])];

  // Record access
  if (injectedIds.length > 0) {
    recordAccess(projectPath, injectedIds);
  }

  return block + '\n\n';
}

/**
 * Build a risk context block for prompts when adaptive trust detects elevated/high risk.
 * Returns empty string for low/normal risk.
 */
export function buildRiskContextBlock(riskAssessment: AdaptiveRiskAssessment | undefined): string {
  if (!riskAssessment) return '';
  if (riskAssessment.level === 'low' || riskAssessment.level === 'normal') return '';

  const lines = [
    '<risk-context>',
    `## Adaptive Risk: ${riskAssessment.level.toUpperCase()} (score: ${riskAssessment.score})`,
    '',
  ];

  if (riskAssessment.fragile_paths.length > 0) {
    lines.push('### Known Fragile Paths');
    for (const fp of riskAssessment.fragile_paths.slice(0, 5)) {
      lines.push(`- \`${fp}\``);
    }
    lines.push('');
  }

  if (riskAssessment.known_issues.length > 0) {
    lines.push('### Known Issues in These Files');
    for (const issue of riskAssessment.known_issues) {
      lines.push(`- ${issue}`);
    }
    lines.push('');
  }

  lines.push('**Be extra careful** — these files have a history of failures. Consider smaller changes and more thorough testing.');
  lines.push('</risk-context>');
  return lines.join('\n') + '\n\n';
}

export function getScoutAutoApprove(): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'SCOUT', category: null });
}

export function getExecuteAutoApprove(category: string | null): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'EXECUTE', category });
}

export function getQaAutoApprove(): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'QA', category: null });
}

export function getPrAutoApprove(): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'PR', category: null });
}
