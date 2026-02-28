/**
 * Issue-Driven Polling
 *
 * Polls GitHub issues labeled "promptwheel" and converts them to
 * TicketProposals for the scout pipeline. Works without the GitHub
 * App — only requires `gh` CLI to be authenticated.
 *
 * Usage:
 *   promptwheel --issues          # Poll once per cycle
 *   promptwheel --issues=myLabel  # Custom label
 */

import { execSync } from 'node:child_process';
import type { TicketProposal, ProposalCategory } from '@promptwheel/core/scout';

// ── Types ───────────────────────────────────────────────────────────────────

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  url: string;
}

export interface IssuePollingOptions {
  /** Label to filter issues by (default: "promptwheel") */
  label: string;
  /** Maximum issues to fetch per poll */
  limit: number;
  /** Repository root for running gh commands */
  repoRoot: string;
}

// ── Label-to-category mapping ───────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, ProposalCategory> = {
  bug: 'fix',
  fix: 'fix',
  refactor: 'refactor',
  refactoring: 'refactor',
  test: 'test',
  tests: 'test',
  testing: 'test',
  docs: 'docs',
  documentation: 'docs',
  perf: 'perf',
  performance: 'perf',
  security: 'security',
  cleanup: 'cleanup',
  types: 'types',
  typescript: 'types',
};

// ── Core ────────────────────────────────────────────────────────────────────

/**
 * Poll GitHub for open issues with the given label and convert them to
 * TicketProposals that can be injected into the scout pipeline.
 */
export function pollGitHubIssues(options: IssuePollingOptions): TicketProposal[] {
  const issues = fetchIssues(options);
  return issues.map((issue, i) => issueToProposal(issue, i));
}

/**
 * Check if `gh` CLI is available and authenticated.
 */
export function isGhAvailable(): boolean {
  try {
    execSync('gh auth status', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch open issues with the specified label using `gh` CLI.
 */
export function fetchIssues(options: IssuePollingOptions): GitHubIssue[] {
  try {
    const json = execSync(
      `gh issue list --label "${options.label}" --state open --limit ${options.limit} --json number,title,body,labels,url`,
      {
        cwd: options.repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000,
      },
    );

    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item: unknown): item is GitHubIssue =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as GitHubIssue).number === 'number' &&
        typeof (item as GitHubIssue).title === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Convert a GitHub issue to a TicketProposal.
 */
export function issueToProposal(issue: GitHubIssue, index: number): TicketProposal {
  const category = inferCategory(issue);
  const body = (issue.body || '').trim();

  // Extract file paths mentioned in the issue body (common patterns)
  const filePaths = extractFilePaths(body);

  return {
    id: `issue-${issue.number}-${Date.now()}-${index}`,
    title: `#${issue.number}: ${issue.title}`,
    description: body.length > 0
      ? `GitHub Issue #${issue.number}\n\n${body.slice(0, 2000)}`
      : `GitHub Issue #${issue.number}: ${issue.title}`,
    category,
    confidence: 70,
    impact_score: 5,
    files: filePaths,
    allowed_paths: filePaths.length > 0 ? filePaths : ['**'],
    acceptance_criteria: [`Resolve GitHub issue #${issue.number}`],
    verification_commands: [],
    rationale: `Requested via GitHub issue #${issue.number}: ${issue.url}`,
    estimated_complexity: 'moderate',
  };
}

/**
 * Infer proposal category from issue labels.
 */
function inferCategory(issue: GitHubIssue): ProposalCategory {
  const labelNames = (issue.labels || []).map(l => l.name.toLowerCase());

  for (const labelName of labelNames) {
    const mapped = CATEGORY_LABELS[labelName];
    if (mapped) return mapped;
  }

  // Check for category keywords in the title
  const titleLower = issue.title.toLowerCase();
  for (const [keyword, cat] of Object.entries(CATEGORY_LABELS)) {
    if (titleLower.includes(keyword)) return cat;
  }

  return 'fix';
}

/**
 * Extract file paths mentioned in issue body text.
 * Looks for patterns like `src/lib/foo.ts`, `packages/cli/src/...`, backtick-quoted paths.
 */
function extractFilePaths(body: string): string[] {
  if (!body) return [];

  const paths = new Set<string>();

  // Match backtick-quoted paths: `src/lib/foo.ts`
  const backtickPattern = /`([a-zA-Z0-9_./-]+\.[a-zA-Z]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = backtickPattern.exec(body)) !== null) {
    const p = match[1];
    if (p.includes('/') && !p.startsWith('http')) {
      paths.add(p);
    }
  }

  // Match bare file paths with common extensions (split by whitespace, check for slash + extension)
  const EXTENSIONS = new Set(['ts', 'js', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'css', 'scss', 'html', 'json', 'yaml', 'yml', 'md', 'toml']);
  for (const word of body.split(/\s+/)) {
    const dotIdx = word.lastIndexOf('.');
    if (dotIdx === -1 || !word.includes('/')) continue;
    const ext = word.slice(dotIdx + 1).replace(/[^a-zA-Z]/g, '');
    if (EXTENSIONS.has(ext) && !word.startsWith('http')) {
      // Strip leading punctuation (quotes, parens, etc.)
      const cleaned = word.replace(/^[^a-zA-Z0-9./]+/, '').replace(/[^a-zA-Z0-9./]+$/, '');
      if (cleaned.includes('/')) paths.add(cleaned);
    }
  }

  return [...paths];
}
