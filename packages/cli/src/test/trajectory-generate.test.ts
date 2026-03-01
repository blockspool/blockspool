/**
 * Tests for trajectory-generate pure functions: slugify(), validateAndBuild(),
 * computeSuggestedScope(), sanitizeVerificationCommands().
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { slugify, validateAndBuild, computeSuggestedScope, sanitizeVerificationCommands, buildGenerateFromProposalsPrompt, extractPlanningAnalysis } from '../lib/trajectory-generate.js';
import { generateTrajectoryFromProposals } from '../lib/trajectory-generate.js';

// ---------------------------------------------------------------------------
// Mocks for generateTrajectoryFromProposals tests
// ---------------------------------------------------------------------------

vi.mock('@promptwheel/core/scout', () => ({
  runClaude: vi.fn(),
  parseClaudeOutput: vi.fn(),
}));

vi.mock('../lib/codebase-index.js', () => ({
  buildCodebaseIndex: vi.fn(() => ({ modules: [], untested_modules: [], large_files: [], dependency_edges: {} })),
  formatIndexForPrompt: vi.fn(() => ''),
}));

vi.mock('../lib/project-metadata/index.js', () => ({
  detectProjectMetadata: vi.fn(() => ({ languages: [], framework: null, test_runner: null, linter: null })),
  formatMetadataForPrompt: vi.fn(() => ''),
}));

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('converts basic text to lowercase kebab-case', () => {
    expect(slugify('Add Auth Module')).toBe('add-auth-module');
  });

  it('replaces special characters with hyphens', () => {
    expect(slugify('hello@world! #test')).toBe('hello-world-test');
  });

  it('collapses consecutive special characters into a single hyphen', () => {
    expect(slugify('foo---bar___baz')).toBe('foo-bar-baz');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('---leading-trailing---')).toBe('leading-trailing');
  });

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
    expect(slugify(long)).toBe('a'.repeat(80));
  });

  it('truncates at 80 chars from longer slugified input', () => {
    const input = 'a'.repeat(79) + ' continuation text here';
    const result = slugify(input);
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('handles string with only special characters', () => {
    expect(slugify('!@#$%^&*()')).toBe('');
  });

  it('preserves numbers', () => {
    expect(slugify('v2.0 release')).toBe('v2-0-release');
  });
});

// ---------------------------------------------------------------------------
// validateAndBuild
// ---------------------------------------------------------------------------

describe('validateAndBuild', () => {
  const validRaw = {
    name: 'test-trajectory',
    description: 'A test trajectory',
    steps: [
      {
        id: 'step-1',
        title: 'First step',
        description: 'Do the first thing',
        scope: 'src/**',
        categories: ['refactor'],
        acceptance_criteria: ['It works'],
        verification_commands: ['npm test'],
        depends_on: [],
      },
      {
        id: 'step-2',
        title: 'Second step',
        description: 'Do the second thing',
        depends_on: ['step-1'],
      },
    ],
  };

  it('builds a valid Trajectory from well-formed input', () => {
    const result = validateAndBuild(validRaw);
    expect(result.name).toBe('test-trajectory');
    expect(result.description).toBe('A test trajectory');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].id).toBe('step-1');
    expect(result.steps[0].title).toBe('First step');
    expect(result.steps[0].scope).toBe('src/**');
    expect(result.steps[0].categories).toEqual(['refactor']);
    expect(result.steps[0].acceptance_criteria).toEqual(['It works']);
    expect(result.steps[0].verification_commands).toEqual(['npm test']);
    expect(result.steps[0].depends_on).toEqual([]);
  });

  it('resolves depends_on references', () => {
    const result = validateAndBuild(validRaw);
    expect(result.steps[1].depends_on).toEqual(['step-1']);
  });

  it('throws on duplicate step IDs', () => {
    const raw = {
      name: 'dup',
      description: 'Duplicate IDs',
      steps: [
        { id: 'same-id', title: 'A', description: 'First' },
        { id: 'same-id', title: 'B', description: 'Second' },
      ],
    };
    expect(() => validateAndBuild(raw)).toThrow('Duplicate step ID: same-id');
  });

  it('throws on unknown depends_on reference', () => {
    const raw = {
      name: 'bad-dep',
      description: 'Bad dependency',
      steps: [
        { id: 'step-a', title: 'A', description: 'First', depends_on: ['nonexistent'] },
      ],
    };
    expect(() => validateAndBuild(raw)).toThrow('depends on unknown step "nonexistent"');
  });

  it('throws when step has empty ID', () => {
    const raw = {
      name: 'no-id',
      description: 'Missing ID',
      steps: [
        { id: '', title: 'No ID', description: 'Missing' },
      ],
    };
    expect(() => validateAndBuild(raw)).toThrow('Step missing ID');
  });

  it('sanitizes step IDs (removes non-alphanumeric chars, lowercases)', () => {
    const raw = {
      name: 'sanitize',
      description: 'Sanitize IDs',
      steps: [
        { id: 'Step_One!@#', title: 'Test', description: 'Test' },
      ],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].id).toBe('step-one---');
  });

  it('handles optional fields gracefully', () => {
    const raw = {
      name: 'minimal',
      description: 'Minimal steps',
      steps: [
        { id: 'step-1', title: 'Minimal', description: 'Just basics' },
      ],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].scope).toBeUndefined();
    expect(result.steps[0].categories).toBeUndefined();
    expect(result.steps[0].acceptance_criteria).toEqual([]);
    expect(result.steps[0].verification_commands).toEqual([]);
    expect(result.steps[0].depends_on).toEqual([]);
    expect(result.steps[0].measure).toBeUndefined();
  });

  it('parses measure field when all properties present', () => {
    const raw = {
      name: 'with-measure',
      description: 'Has measure',
      steps: [
        {
          id: 'step-1',
          title: 'Measured',
          description: 'With measure',
          measure: { cmd: 'wc -l src/**', target: 100, direction: 'down' },
        },
      ],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].measure).toEqual({
      cmd: 'wc -l src/**',
      target: 100,
      direction: 'down',
    });
  });

  it('ignores partial measure field (missing target)', () => {
    const raw = {
      name: 'partial-measure',
      description: 'Partial measure',
      steps: [
        {
          id: 'step-1',
          title: 'Test',
          description: 'Test',
          measure: { cmd: 'wc -l' },
        },
      ],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].measure).toBeUndefined();
  });

  it('defaults measure direction to "up" for unknown values', () => {
    const raw = {
      name: 'measure-dir',
      description: 'Measure direction',
      steps: [
        {
          id: 'step-1',
          title: 'Test',
          description: 'Test',
          measure: { cmd: 'coverage', target: 80, direction: 'invalid' },
        },
      ],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].measure?.direction).toBe('up');
  });

  it('throws on circular dependencies (simple A↔B)', () => {
    const raw = {
      name: 'cycle',
      description: 'Circular deps',
      steps: [
        { id: 'a', title: 'A', description: 'First', depends_on: ['b'] },
        { id: 'b', title: 'B', description: 'Second', depends_on: ['a'] },
      ],
    };
    expect(() => validateAndBuild(raw)).toThrow('Circular dependency detected');
  });

  it('throws on longer circular dependency chain (A→B→C→D→A)', () => {
    const raw = {
      name: 'long-cycle',
      description: 'Long cycle',
      steps: [
        { id: 'a', title: 'A', description: 'First', depends_on: ['d'] },
        { id: 'b', title: 'B', description: 'Second', depends_on: ['a'] },
        { id: 'c', title: 'C', description: 'Third', depends_on: ['b'] },
        { id: 'd', title: 'D', description: 'Fourth', depends_on: ['c'] },
      ],
    };
    expect(() => validateAndBuild(raw)).toThrow('Circular dependency detected');
  });

  it('coerces non-string fields to strings', () => {
    const raw = {
      name: 'coerce',
      description: 'Coercion test',
      steps: [
        {
          id: 123,
          title: 456,
          description: null,
          acceptance_criteria: [789],
          verification_commands: [true],
          depends_on: [],
        },
      ],
    };
    // @ts-expect-error — testing runtime coercion of bad types
    const result = validateAndBuild(raw);
    expect(result.steps[0].id).toBe('123');
    expect(result.steps[0].title).toBe('456');
    expect(result.steps[0].description).toBe(''); // null || '' → ''
    expect(result.steps[0].acceptance_criteria).toEqual(['789']);
    expect(result.steps[0].verification_commands).toEqual([]); // 'true' is sanitized out
  });
});

// ---------------------------------------------------------------------------
// computeSuggestedScope
// ---------------------------------------------------------------------------

describe('computeSuggestedScope', () => {
  it('returns common parent directory for files in same dir', () => {
    expect(computeSuggestedScope(['src/auth/login.ts', 'src/auth/session.ts']))
      .toBe('src/auth/**');
  });

  it('returns deeper common prefix for nested files', () => {
    expect(computeSuggestedScope(['packages/cli/src/lib/foo.ts', 'packages/cli/src/lib/bar.ts']))
      .toBe('packages/cli/src/lib/**');
  });

  it('returns shallow prefix when files span different dirs', () => {
    expect(computeSuggestedScope(['src/auth/login.ts', 'src/db/connect.ts']))
      .toBe('src/**');
  });

  it('returns undefined for empty array', () => {
    expect(computeSuggestedScope([])).toBeUndefined();
  });

  it('returns undefined for root-level files with no common dir', () => {
    expect(computeSuggestedScope(['auth.ts', 'db.ts'])).toBeUndefined();
  });

  it('returns undefined when files share no common directory', () => {
    expect(computeSuggestedScope(['src/foo.ts', 'lib/bar.ts'])).toBeUndefined();
  });

  it('handles single file', () => {
    expect(computeSuggestedScope(['src/auth/login.ts'])).toBe('src/auth/**');
  });

  it('handles files at different depths with common prefix', () => {
    expect(computeSuggestedScope(['src/auth/login.ts', 'src/auth/utils/hash.ts']))
      .toBe('src/auth/**');
  });
});

// ---------------------------------------------------------------------------
// sanitizeVerificationCommands
// ---------------------------------------------------------------------------

describe('sanitizeVerificationCommands', () => {
  it('keeps valid commands', () => {
    expect(sanitizeVerificationCommands(['npm test', 'npx vitest run']))
      .toEqual(['npm test', 'npx vitest run']);
  });

  it('removes empty commands', () => {
    expect(sanitizeVerificationCommands(['', '  ', 'npm test']))
      .toEqual(['npm test']);
  });

  it('removes pure punctuation/numbers', () => {
    expect(sanitizeVerificationCommands(['42', '!!!', 'npm test']))
      .toEqual(['npm test']);
  });

  it('removes commands with hardcoded line numbers at end', () => {
    expect(sanitizeVerificationCommands(['grep "foo" src/bar.ts:42', 'npm test']))
      .toEqual(['npm test']);
  });

  it('removes commands with --line flag', () => {
    expect(sanitizeVerificationCommands(['sed --line 15 foo.ts', 'npm test']))
      .toEqual(['npm test']);
  });

  it('removes bare "true" and "false"', () => {
    expect(sanitizeVerificationCommands(['true', 'false', 'npm test']))
      .toEqual(['npm test']);
  });

  it('keeps commands with colon in non-line-number context', () => {
    expect(sanitizeVerificationCommands(['npm run test:unit']))
      .toEqual(['npm run test:unit']);
  });

  it('returns empty array when all commands are invalid', () => {
    expect(sanitizeVerificationCommands(['', '42', 'true']))
      .toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateAndBuild — verification command sanitization
// ---------------------------------------------------------------------------

describe('validateAndBuild — sanitization', () => {
  it('sanitizes verification commands during build', () => {
    const raw = {
      name: 'sanitize-test',
      description: 'Test sanitization',
      steps: [{
        id: 'step-1',
        title: 'Test',
        description: 'Test',
        verification_commands: ['npm test', '', 'true', 'grep "foo" bar.ts:42'],
      }],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].verification_commands).toEqual(['npm test']);
  });
});

// ---------------------------------------------------------------------------
// generateTrajectoryFromProposals (mocked LLM)
// ---------------------------------------------------------------------------

describe('generateTrajectoryFromProposals (mocked LLM)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-gen-'));
    fs.mkdirSync(path.join(tmpDir, '.promptwheel', 'trajectories'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const sampleProposals = [
    {
      title: 'Add input validation',
      description: 'Validate user inputs',
      category: 'security',
      files: ['src/auth.ts'],
      allowed_paths: ['src/**'],
      acceptance_criteria: ['All inputs validated'],
      verification_commands: ['npm test'],
      confidence: 80,
      impact_score: 7,
      rationale: 'Security improvement',
      estimated_complexity: 'medium',
    },
  ];

  it('generates trajectory from valid LLM response', async () => {
    const { runClaude, parseClaudeOutput } = await import('@promptwheel/core/scout');

    (runClaude as any).mockResolvedValue({
      success: true,
      output: 'mock output',
    });

    (parseClaudeOutput as any).mockReturnValue({
      name: 'drill-security-hardening',
      description: 'Security hardening trajectory',
      steps: [
        {
          id: 'step-1',
          title: 'Add input validation',
          description: 'Validate all user inputs',
          scope: 'src/**',
          categories: ['security'],
          acceptance_criteria: ['All inputs validated'],
          verification_commands: ['npm test'],
          depends_on: [],
        },
      ],
    });

    const result = await generateTrajectoryFromProposals({
      proposals: sampleProposals,
      repoRoot: tmpDir,
    });

    expect(result.trajectory.name).toMatch(/^drill-security-hardening-\d+$/);
    expect(result.trajectory.steps).toHaveLength(1);
    expect(result.filePath).toContain('.promptwheel/trajectories/');
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('throws on malformed LLM response (no JSON block)', async () => {
    const { runClaude, parseClaudeOutput } = await import('@promptwheel/core/scout');

    (runClaude as any).mockResolvedValue({
      success: true,
      output: 'no json here, just text',
    });

    (parseClaudeOutput as any).mockReturnValue(null);

    await expect(
      generateTrajectoryFromProposals({
        proposals: sampleProposals,
        repoRoot: tmpDir,
      }),
    ).rejects.toThrow('Trajectory generation failed during response parsing');
  });

  it('throws on LLM call failure', async () => {
    const { runClaude } = await import('@promptwheel/core/scout');

    (runClaude as any).mockResolvedValue({
      success: false,
      error: 'API timeout',
    });

    await expect(
      generateTrajectoryFromProposals({
        proposals: sampleProposals,
        repoRoot: tmpDir,
      }),
    ).rejects.toThrow('Trajectory generation failed during LLM call');
  });
});

// ---------------------------------------------------------------------------
// buildGenerateFromProposalsPrompt — dynamic ambition + stratification
// ---------------------------------------------------------------------------

describe('buildGenerateFromProposalsPrompt — ambition levels', () => {
  const proposalsBlock = '1. [fix] Fix auth bug (score: 5.0, complexity: medium)\n   Files: src/auth.ts\n   Fix the auth bug';
  const indexBlock = '';
  const metaBlock = '';

  it('includes conservative first-step directive', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
      ambitionLevel: 'conservative',
    });
    expect(prompt).toContain('First step must be trivially safe');
    expect(prompt).toContain('touch exactly 1 file');
    expect(prompt).toContain('Trivial (1 file, guaranteed win)');
  });

  it('includes ambitious first-step directive', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
      ambitionLevel: 'ambitious',
    });
    expect(prompt).toContain('moderate complexity allowed');
    expect(prompt).toContain('3-5 files');
    expect(prompt).toContain('Moderate (real problem, self-contained)');
  });

  it('includes moderate (default) first-step directive', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
      ambitionLevel: 'moderate',
    });
    expect(prompt).toContain('First step must be a "gimme"');
    expect(prompt).toContain('Simple (1-3 files, quick win)');
  });

  it('defaults to moderate when ambitionLevel is undefined', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {});
    expect(prompt).toContain('First step must be a "gimme"');
    expect(prompt).toContain('Simple (1-3 files, quick win)');
  });

  it('always includes complexity stratification gradient', () => {
    for (const level of ['conservative', 'moderate', 'ambitious'] as const) {
      const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
        ambitionLevel: level,
      });
      expect(prompt).toContain('Complexity gradient across steps');
      expect(prompt).toContain('Step 2: Moderate complexity');
      expect(prompt).toContain('Steps 3+: Full complexity allowed');
      expect(prompt).toContain('Final step: Consolidation');
    }
  });

  it('includes short trajectory guidance in stratification', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
      ambitionLevel: 'moderate',
    });
    expect(prompt).toContain('short trajectories (2-3 steps)');
    expect(prompt).toContain('consolidation role merges');
  });

  it('does not have separate arc guidance section (merged into causal context)', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {});
    expect(prompt).not.toContain('## Trajectory Arc Guidance');
  });

  it('adapts target step count for conservative ambition', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
      ambitionLevel: 'conservative',
    });
    expect(prompt).toContain('2-3 steps');
  });

  it('adapts target step count for ambitious ambition', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
      ambitionLevel: 'ambitious',
    });
    expect(prompt).toContain('5-8 steps');
  });

  it('uses balanced step count for moderate ambition', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
      ambitionLevel: 'moderate',
    });
    expect(prompt).toContain('3-5 steps');
  });
});

// ---------------------------------------------------------------------------
// extractPlanningAnalysis
// ---------------------------------------------------------------------------

describe('extractPlanningAnalysis', () => {
  it('extracts content from <planning> tags', () => {
    const output = `<planning>
Theme: Security hardening
Groups: Auth and session proposals cluster
Dependencies: Core before auth
</planning>

{
  "name": "drill-security",
  "description": "Security trajectory",
  "steps": []
}`;

    const analysis = extractPlanningAnalysis(output);
    expect(analysis).toContain('Theme: Security hardening');
    expect(analysis).toContain('Dependencies: Core before auth');
  });

  it('returns null when no planning block present', () => {
    const output = '{ "name": "drill-test", "description": "test", "steps": [] }';
    expect(extractPlanningAnalysis(output)).toBeNull();
  });

  it('handles multiline planning content', () => {
    const output = `<planning>
Line 1
Line 2
Line 3
</planning>
{"name":"x","description":"y","steps":[]}`;

    const analysis = extractPlanningAnalysis(output);
    expect(analysis).toContain('Line 1');
    expect(analysis).toContain('Line 3');
  });

  it('trims whitespace from extracted content', () => {
    const output = '<planning>  trimmed  </planning>{}';
    expect(extractPlanningAnalysis(output)).toBe('trimmed');
  });
});

// ---------------------------------------------------------------------------
// buildGenerateFromProposalsPrompt — blueprint context
// ---------------------------------------------------------------------------

describe('buildGenerateFromProposalsPrompt — blueprint context', () => {
  const proposalsBlock = '1. [fix] Fix auth bug (score: 5.0)\n   Files: src/auth.ts';
  const indexBlock = '';
  const metaBlock = '';

  it('includes strategic analysis section when blueprintContext is provided', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
      blueprintContext: 'Arc: 2 group(s) total\n\nGroups:\n  1. [fix] Fix auth → scope: src/auth/**',
    });
    expect(prompt).toContain('## Strategic Analysis (pre-computed)');
    expect(prompt).toContain('Arc: 2 group(s) total');
    expect(prompt).toContain('Respect this analysis');
  });

  it('omits strategic analysis when no blueprintContext', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {});
    expect(prompt).not.toContain('## Strategic Analysis');
  });

  it('includes two-phase output format when blueprintContext is provided', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {
      blueprintContext: 'Arc: 1 group(s) total',
    });
    expect(prompt).toContain('Phase 1');
    expect(prompt).toContain('<planning>');
    expect(prompt).toContain('Phase 2');
  });

  it('uses single-phase output when no blueprintContext', () => {
    const prompt = buildGenerateFromProposalsPrompt(proposalsBlock, indexBlock, metaBlock, {});
    expect(prompt).toContain('Respond with ONLY a JSON object');
    expect(prompt).not.toContain('Phase 1');
  });
});

// ---------------------------------------------------------------------------
// generateTrajectoryFromProposals — quality gate retry (mocked LLM)
// ---------------------------------------------------------------------------

describe('generateTrajectoryFromProposals — quality gate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-qg-'));
    fs.mkdirSync(path.join(tmpDir, '.promptwheel', 'trajectories'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const sampleProposals = [
    {
      title: 'Fix auth types',
      description: 'Fix type issues in auth',
      category: 'types',
      files: ['src/auth/login.ts', 'src/auth/session.ts'],
      allowed_paths: ['src/auth/**'],
      acceptance_criteria: ['Types fixed'],
      verification_commands: ['npm run typecheck'],
      confidence: 85,
      impact_score: 7,
      rationale: 'Type safety',
      estimated_complexity: 'simple',
    },
  ];

  it('includes planningAnalysis when LLM outputs planning block', async () => {
    const { runClaude, parseClaudeOutput } = await import('@promptwheel/core/scout');

    (runClaude as any).mockResolvedValue({
      success: true,
      output: '<planning>\nTheme: Type safety\nDeps: none\n</planning>\n\n{"name":"drill-types","description":"types","steps":[{"id":"s1","title":"Fix types","description":"fix","scope":"src/auth/**","categories":["types"],"acceptance_criteria":["done"],"verification_commands":["npm run typecheck"],"depends_on":[]}]}',
    });

    (parseClaudeOutput as any).mockReturnValue({
      name: 'drill-types',
      description: 'types',
      steps: [{
        id: 's1',
        title: 'Fix types',
        description: 'fix',
        scope: 'src/auth/**',
        categories: ['types'],
        acceptance_criteria: ['done'],
        verification_commands: ['npm run typecheck'],
        depends_on: [],
      }],
    });

    const result = await generateTrajectoryFromProposals({
      proposals: sampleProposals,
      repoRoot: tmpDir,
      blueprintContext: 'Arc: 1 group(s) total',
    });

    expect(result.planningAnalysis).toContain('Theme: Type safety');
  });

  it('returns qualityRetried=false when quality gate passes', async () => {
    const { runClaude, parseClaudeOutput } = await import('@promptwheel/core/scout');

    (runClaude as any).mockResolvedValue({
      success: true,
      output: 'mock output',
    });

    (parseClaudeOutput as any).mockReturnValue({
      name: 'drill-types',
      description: 'types',
      steps: [
        { id: 's1', title: 'Fix types', description: 'fix', scope: 'src/auth/**', categories: ['types'], acceptance_criteria: ['done'], verification_commands: ['npm run typecheck'], depends_on: [] },
        { id: 's2', title: 'Test types', description: 'test', scope: 'src/auth/**', categories: ['test'], acceptance_criteria: ['done'], verification_commands: ['npm test'], depends_on: ['s1'] },
        { id: 's3', title: 'Cleanup', description: 'cleanup', scope: 'src/auth/**', categories: ['cleanup'], acceptance_criteria: ['done'], verification_commands: ['npm run lint'], depends_on: ['s2'] },
      ],
    });

    const result = await generateTrajectoryFromProposals({
      proposals: sampleProposals,
      repoRoot: tmpDir,
      blueprintContext: 'Arc: 1 group(s) total',
    });

    expect(result.qualityRetried).toBe(false);
  });
});
