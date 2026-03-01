import { describe, it, expect } from 'vitest';
import { buildOrUpdatePortfolio, formatPortfolioForPrompt, type ProjectPortfolio } from '../lib/portfolio.js';

describe('buildOrUpdatePortfolio', () => {
  const repoRoot = '/tmp/test-portfolio-' + Date.now();

  it('builds from scratch with no data', () => {
    const portfolio = buildOrUpdatePortfolio(repoRoot, null, [], []);
    expect(portfolio.version).toBe(1);
    expect(portfolio.architecture.buildSystem).toBe('unknown');
    expect(portfolio.hotspots).toEqual([]);
    expect(portfolio.decisions).toEqual([]);
  });

  it('aggregates hotspots from drill history', () => {
    const drillHistory = [
      {
        name: 'traj-1', description: 'test', stepsTotal: 3, stepsCompleted: 1,
        stepsFailed: 2, outcome: 'stalled' as const, completionPct: 0.33,
        categories: ['fix'], scopes: ['src/auth'],
        failedSteps: [{ id: 's1', title: 'fix login', reason: 'test failed' }],
      },
      {
        name: 'traj-2', description: 'test2', stepsTotal: 2, stepsCompleted: 0,
        stepsFailed: 2, outcome: 'stalled' as const, completionPct: 0,
        categories: ['fix'], scopes: ['src/auth'],
        failedSteps: [{ id: 's2', title: 'fix session', reason: 'timeout' }],
      },
    ];
    const portfolio = buildOrUpdatePortfolio(repoRoot, null, drillHistory, []);
    expect(portfolio.hotspots.length).toBe(1);
    expect(portfolio.hotspots[0].path).toBe('src/auth');
    expect(portfolio.hotspots[0].failureCount).toBe(2);
  });

  it('ignores completed trajectories for hotspot aggregation', () => {
    const drillHistory = [
      {
        name: 'traj-1', description: 'test', stepsTotal: 3, stepsCompleted: 3,
        stepsFailed: 0, outcome: 'completed' as const, completionPct: 1,
        categories: ['refactor'], scopes: ['src/utils'],
      },
    ];
    const portfolio = buildOrUpdatePortfolio(repoRoot, null, drillHistory, []);
    expect(portfolio.hotspots).toEqual([]);
  });

  it('computes category patterns from drill history', () => {
    const drillHistory = [
      { name: 't1', description: '', stepsTotal: 3, stepsCompleted: 3, stepsFailed: 0, outcome: 'completed' as const, completionPct: 1, categories: ['refactor'], scopes: ['src/'] },
      { name: 't2', description: '', stepsTotal: 3, stepsCompleted: 3, stepsFailed: 0, outcome: 'completed' as const, completionPct: 1, categories: ['refactor'], scopes: ['src/'] },
      { name: 't3', description: '', stepsTotal: 3, stepsCompleted: 0, stepsFailed: 3, outcome: 'stalled' as const, completionPct: 0, categories: ['security'], scopes: ['src/'] },
      { name: 't4', description: '', stepsTotal: 3, stepsCompleted: 0, stepsFailed: 3, outcome: 'stalled' as const, completionPct: 0, categories: ['security'], scopes: ['src/'] },
    ];
    const portfolio = buildOrUpdatePortfolio(repoRoot, null, drillHistory, []);
    expect(portfolio.patterns.preferredCategories).toContain('refactor');
    expect(portfolio.patterns.avoidCategories).toContain('security');
  });

  it('computes scope success rates', () => {
    const drillHistory = [
      { name: 't1', description: '', stepsTotal: 3, stepsCompleted: 3, stepsFailed: 0, outcome: 'completed' as const, completionPct: 1, categories: ['refactor'], scopes: ['src/core'] },
      { name: 't2', description: '', stepsTotal: 3, stepsCompleted: 3, stepsFailed: 0, outcome: 'completed' as const, completionPct: 1, categories: ['refactor'], scopes: ['src/core'] },
      { name: 't3', description: '', stepsTotal: 3, stepsCompleted: 0, stepsFailed: 3, outcome: 'stalled' as const, completionPct: 0, categories: ['fix'], scopes: ['src/api'] },
      { name: 't4', description: '', stepsTotal: 3, stepsCompleted: 0, stepsFailed: 3, outcome: 'stalled' as const, completionPct: 0, categories: ['fix'], scopes: ['src/api'] },
    ];
    const portfolio = buildOrUpdatePortfolio(repoRoot, null, drillHistory, []);
    expect(portfolio.patterns.successRateByScope['src/core']).toBe(1);
    expect(portfolio.patterns.successRateByScope['src/api']).toBe(0);
  });

  it('populates architecture from codebase index', () => {
    const codebaseIndex = {
      modules: [
        { path: 'src/core' },
        { path: 'src/api' },
        { path: 'src/utils' },
      ],
      graph_metrics: {
        hub_modules: ['src/core', 'src/utils'],
      },
    };
    const portfolio = buildOrUpdatePortfolio(repoRoot, codebaseIndex, [], []);
    expect(portfolio.architecture.coreModules).toEqual(['src/core', 'src/utils']);
    expect(portfolio.architecture.entryPoints).toEqual(['src/core', 'src/api', 'src/utils']);
  });

  it('extracts decisions from blueprint learnings', () => {
    const learnings = [
      { id: 'l1', text: 'Auth module needs refactoring', category: 'refactor', source: { type: 'drill_blueprint' }, tags: [] },
      { id: 'l2', text: 'Regular learning', category: 'fix', source: { type: 'execution' }, tags: [] },
      { id: 'l3', text: 'Blueprint tagged', category: 'perf', source: { type: 'scout' }, tags: ['blueprint'] },
    ];
    const portfolio = buildOrUpdatePortfolio(repoRoot, null, [], learnings);
    expect(portfolio.decisions.length).toBe(2);
    expect(portfolio.decisions[0].summary).toBe('Auth module needs refactoring');
    expect(portfolio.decisions[1].summary).toBe('Blueprint tagged');
  });

  it('computes avg steps per trajectory', () => {
    const drillHistory = [
      { name: 't1', description: '', stepsTotal: 4, stepsCompleted: 4, stepsFailed: 0, outcome: 'completed' as const, completionPct: 1, categories: ['refactor'], scopes: ['src/'] },
      { name: 't2', description: '', stepsTotal: 6, stepsCompleted: 3, stepsFailed: 3, outcome: 'stalled' as const, completionPct: 0.5, categories: ['fix'], scopes: ['src/'] },
    ];
    const portfolio = buildOrUpdatePortfolio(repoRoot, null, drillHistory, []);
    expect(portfolio.patterns.avgStepsPerTrajectory).toBe(5);
  });
});

describe('formatPortfolioForPrompt', () => {
  it('formats a portfolio within char budget', () => {
    const portfolio: ProjectPortfolio = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      architecture: { entryPoints: [], coreModules: ['src/core/index.ts'], testStrategy: 'vitest', buildSystem: 'npm' },
      hotspots: [{ path: 'src/auth/session.ts', failureCount: 3, lastFailure: '', commonErrors: [] }],
      decisions: [],
      patterns: { avgStepsPerTrajectory: 4, preferredCategories: ['refactor'], avoidCategories: [], successRateByScope: {} },
    };
    const result = formatPortfolioForPrompt(portfolio);
    expect(result).toContain('<project-portfolio>');
    expect(result).toContain('</project-portfolio>');
    expect(result.length).toBeLessThanOrEqual(550); // 500 content + tags
  });

  it('includes core modules', () => {
    const portfolio: ProjectPortfolio = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      architecture: { entryPoints: [], coreModules: ['src/core', 'src/utils'], testStrategy: 'vitest', buildSystem: 'npm' },
      hotspots: [],
      decisions: [],
      patterns: { avgStepsPerTrajectory: 0, preferredCategories: [], avoidCategories: [], successRateByScope: {} },
    };
    const result = formatPortfolioForPrompt(portfolio);
    expect(result).toContain('src/core');
    expect(result).toContain('high fan-in');
  });

  it('includes hotspot information', () => {
    const portfolio: ProjectPortfolio = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      architecture: { entryPoints: [], coreModules: [], testStrategy: 'vitest', buildSystem: 'npm' },
      hotspots: [{ path: 'src/auth', failureCount: 5, lastFailure: '', commonErrors: [] }],
      decisions: [],
      patterns: { avgStepsPerTrajectory: 0, preferredCategories: [], avoidCategories: [], successRateByScope: {} },
    };
    const result = formatPortfolioForPrompt(portfolio);
    expect(result).toContain('src/auth');
    expect(result).toContain('5 failures');
  });

  it('includes avoid categories', () => {
    const portfolio: ProjectPortfolio = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      architecture: { entryPoints: [], coreModules: [], testStrategy: 'vitest', buildSystem: 'npm' },
      hotspots: [],
      decisions: [],
      patterns: { avgStepsPerTrajectory: 0, preferredCategories: [], avoidCategories: ['security', 'migration'], successRateByScope: {} },
    };
    const result = formatPortfolioForPrompt(portfolio);
    expect(result).toContain('Low success: security, migration');
  });

  it('truncates long content', () => {
    const portfolio: ProjectPortfolio = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      architecture: { entryPoints: Array(20).fill('very/long/path/file.ts'), coreModules: Array(20).fill('long/module/path.ts'), testStrategy: 'vitest', buildSystem: 'npm' },
      hotspots: Array(10).fill({ path: 'some/very/long/path/to/file.ts', failureCount: 5, lastFailure: '', commonErrors: ['very long error message that takes space'] }),
      decisions: [],
      patterns: { avgStepsPerTrajectory: 4, preferredCategories: ['a', 'b', 'c', 'd', 'e'], avoidCategories: ['f', 'g', 'h'], successRateByScope: { 'src/': 0.8, 'lib/': 0.6, 'test/': 0.4 } },
    };
    const result = formatPortfolioForPrompt(portfolio);
    // Content between tags should be <= 500 chars
    const content = result.replace('<project-portfolio>\n', '').replace('\n</project-portfolio>', '');
    expect(content.length).toBeLessThanOrEqual(500);
  });

  it('returns empty content tags for empty portfolio', () => {
    const portfolio: ProjectPortfolio = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      architecture: { entryPoints: [], coreModules: [], testStrategy: 'unknown', buildSystem: 'unknown' },
      hotspots: [],
      decisions: [],
      patterns: { avgStepsPerTrajectory: 0, preferredCategories: [], avoidCategories: [], successRateByScope: {} },
    };
    const result = formatPortfolioForPrompt(portfolio);
    expect(result).toBe('<project-portfolio>\n\n</project-portfolio>');
  });
});
