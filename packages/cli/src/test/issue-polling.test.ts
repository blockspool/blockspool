import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'node:child_process';

vi.mock('node:child_process');

const mockedCp = vi.mocked(child_process);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('issueToProposal', () => {
  it('converts a GitHub issue to a TicketProposal', async () => {
    const { issueToProposal } = await import('../lib/issue-polling.js');
    const proposal = issueToProposal({
      number: 42,
      title: 'Fix login redirect',
      body: 'The login page redirects incorrectly when session expires.',
      labels: [{ name: 'bug' }],
      url: 'https://github.com/example/repo/issues/42',
    }, 0);

    expect(proposal.id).toMatch(/^issue-42-/);
    expect(proposal.title).toBe('#42: Fix login redirect');
    expect(proposal.category).toBe('fix');
    expect(proposal.confidence).toBe(70);
    expect(proposal.acceptance_criteria).toContain('Resolve GitHub issue #42');
    expect(proposal.rationale).toContain('https://github.com/example/repo/issues/42');
  });

  it('infers category from labels', async () => {
    const { issueToProposal } = await import('../lib/issue-polling.js');

    const testCases: Array<{ labels: string[]; expected: string }> = [
      { labels: ['refactor'], expected: 'refactor' },
      { labels: ['test'], expected: 'test' },
      { labels: ['documentation'], expected: 'docs' },
      { labels: ['performance'], expected: 'perf' },
      { labels: ['security'], expected: 'security' },
      { labels: ['cleanup'], expected: 'cleanup' },
      { labels: ['typescript'], expected: 'types' },
    ];

    for (const { labels, expected } of testCases) {
      const proposal = issueToProposal({
        number: 1,
        title: 'Some issue',
        body: '',
        labels: labels.map(name => ({ name })),
        url: 'https://github.com/example/repo/issues/1',
      }, 0);
      expect(proposal.category).toBe(expected);
    }
  });

  it('defaults to fix when no matching labels', async () => {
    const { issueToProposal } = await import('../lib/issue-polling.js');
    const proposal = issueToProposal({
      number: 1,
      title: 'Some unrelated issue',
      body: '',
      labels: [{ name: 'enhancement' }],
      url: 'https://github.com/example/repo/issues/1',
    }, 0);
    expect(proposal.category).toBe('fix');
  });

  it('extracts file paths from issue body', async () => {
    const { issueToProposal } = await import('../lib/issue-polling.js');
    const proposal = issueToProposal({
      number: 5,
      title: 'Fix import',
      body: 'The file `src/lib/auth.ts` has a broken import. Also check src/utils/helpers.ts for related code.',
      labels: [],
      url: 'https://github.com/example/repo/issues/5',
    }, 0);
    expect(proposal.files).toContain('src/lib/auth.ts');
    expect(proposal.files).toContain('src/utils/helpers.ts');
    expect(proposal.allowed_paths).toContain('src/lib/auth.ts');
  });

  it('uses ** for allowed_paths when no file paths found', async () => {
    const { issueToProposal } = await import('../lib/issue-polling.js');
    const proposal = issueToProposal({
      number: 1,
      title: 'Fix something',
      body: 'This is broken',
      labels: [],
      url: 'https://github.com/example/repo/issues/1',
    }, 0);
    expect(proposal.allowed_paths).toEqual(['**']);
  });
});

describe('fetchIssues', () => {
  it('calls gh issue list and parses JSON output', async () => {
    const { fetchIssues } = await import('../lib/issue-polling.js');
    const issues = [
      { number: 1, title: 'Issue 1', body: 'Body 1', labels: [], url: 'https://...' },
      { number: 2, title: 'Issue 2', body: 'Body 2', labels: [{ name: 'bug' }], url: 'https://...' },
    ];
    mockedCp.execSync.mockReturnValue(JSON.stringify(issues));

    const result = fetchIssues({ label: 'promptwheel', limit: 10, repoRoot: '/repo' });
    expect(result).toHaveLength(2);
    expect(result[0].number).toBe(1);
    expect(mockedCp.execSync).toHaveBeenCalledWith(
      expect.stringContaining('--label "promptwheel"'),
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('returns empty array on failure', async () => {
    const { fetchIssues } = await import('../lib/issue-polling.js');
    mockedCp.execSync.mockImplementation(() => { throw new Error('gh not found'); });

    const result = fetchIssues({ label: 'promptwheel', limit: 10, repoRoot: '/repo' });
    expect(result).toEqual([]);
  });

  it('returns empty array on invalid JSON', async () => {
    const { fetchIssues } = await import('../lib/issue-polling.js');
    mockedCp.execSync.mockReturnValue('not json');

    const result = fetchIssues({ label: 'promptwheel', limit: 10, repoRoot: '/repo' });
    expect(result).toEqual([]);
  });
});

describe('isGhAvailable', () => {
  it('returns true when gh auth status succeeds', async () => {
    const { isGhAvailable } = await import('../lib/issue-polling.js');
    mockedCp.execSync.mockReturnValue('Logged in to github.com');
    expect(isGhAvailable()).toBe(true);
  });

  it('returns false when gh auth status fails', async () => {
    const { isGhAvailable } = await import('../lib/issue-polling.js');
    mockedCp.execSync.mockImplementation(() => { throw new Error('not logged in'); });
    expect(isGhAvailable()).toBe(false);
  });
});

describe('pollGitHubIssues', () => {
  it('fetches and converts issues to proposals', async () => {
    const { pollGitHubIssues } = await import('../lib/issue-polling.js');
    const issues = [
      { number: 10, title: 'Add tests', body: 'Need more tests for `src/auth.ts`', labels: [{ name: 'test' }], url: 'https://...' },
    ];
    mockedCp.execSync.mockReturnValue(JSON.stringify(issues));

    const proposals = pollGitHubIssues({ label: 'promptwheel', limit: 10, repoRoot: '/repo' });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toBe('#10: Add tests');
    expect(proposals[0].category).toBe('test');
    expect(proposals[0].files).toContain('src/auth.ts');
  });
});
