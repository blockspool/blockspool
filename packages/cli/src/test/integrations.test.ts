import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadIntegrations,
  parseIntegrationsYaml,
  toProposals,
  toLearnings,
  toNudges,
  runIntegrations,
  type IntegrationConfig,
  type IntegrationResult,
} from '../lib/integrations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function writeIntegrationsYaml(content: string): void {
  const dir = path.join(tmpDir, '.promptwheel');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'integrations.yaml'), content, 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrations-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadIntegrations
// ---------------------------------------------------------------------------

describe('loadIntegrations', () => {
  it('returns empty providers when no file exists', () => {
    const config = loadIntegrations(tmpDir);
    expect(config.providers).toEqual([]);
  });

  it('parses valid YAML file', () => {
    writeIntegrationsYaml(`
providers:
  - name: securitychecks
    command: "npx @securitychecks/mcp-server"
    tool: security_scan
    every: 5
    phase: pre-scout
    feed: proposals
    timeout: 30000
`);
    const config = loadIntegrations(tmpDir);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]).toEqual({
      name: 'securitychecks',
      command: 'npx @securitychecks/mcp-server',
      tool: 'security_scan',
      every: 5,
      phase: 'pre-scout',
      feed: 'proposals',
      timeout: 30000,
    });
  });

  it('parses multiple providers', () => {
    writeIntegrationsYaml(`
providers:
  - name: security
    command: "npx sec-server"
    tool: scan
    every: 5
    feed: proposals
  - name: patterns
    command: "npx pattern-server"
    tool: analyze
    every: 10
    phase: post-cycle
    feed: learnings
`);
    const config = loadIntegrations(tmpDir);
    expect(config.providers).toHaveLength(2);
    expect(config.providers[0].name).toBe('security');
    expect(config.providers[1].name).toBe('patterns');
    expect(config.providers[1].phase).toBe('post-cycle');
    expect(config.providers[1].feed).toBe('learnings');
  });

  it('applies defaults for optional fields', () => {
    writeIntegrationsYaml(`
providers:
  - name: minimal
    command: "node server.js"
    tool: run
    every: 3
`);
    const config = loadIntegrations(tmpDir);
    expect(config.providers[0].phase).toBe('pre-scout');
    expect(config.providers[0].feed).toBe('proposals');
    expect(config.providers[0].timeout).toBe(60_000);
  });

  it('also loads .yml extension', () => {
    const dir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'integrations.yml'), `
providers:
  - name: test
    command: "node test.js"
    tool: run
    every: 1
`, 'utf-8');
    const config = loadIntegrations(tmpDir);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].name).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// parseIntegrationsYaml
// ---------------------------------------------------------------------------

describe('parseIntegrationsYaml', () => {
  it('skips invalid providers (missing required fields)', () => {
    const config = parseIntegrationsYaml(`
providers:
  - name: incomplete
    command: "node server.js"
`);
    // Missing tool and every — should be skipped
    expect(config.providers).toHaveLength(0);
  });

  it('skips providers with invalid phase', () => {
    const config = parseIntegrationsYaml(`
providers:
  - name: bad
    command: "node server.js"
    tool: run
    every: 1
    phase: invalid
`);
    expect(config.providers).toHaveLength(0);
  });

  it('skips providers with invalid feed', () => {
    const config = parseIntegrationsYaml(`
providers:
  - name: bad
    command: "node server.js"
    tool: run
    every: 1
    feed: invalid
`);
    expect(config.providers).toHaveLength(0);
  });

  it('parses args sub-object', () => {
    const config = parseIntegrationsYaml(`
providers:
  - name: withargs
    command: "node server.js"
    tool: scan
    every: 5
    args:
      severity: high
      maxFiles: 100
      verbose: true
`);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].args).toEqual({
      severity: 'high',
      maxFiles: 100,
      verbose: true,
    });
  });

  it('handles comments and empty lines', () => {
    const config = parseIntegrationsYaml(`
# Integration providers
providers:
  # Security scanner
  - name: sec
    command: "node sec.js"
    tool: scan
    every: 3

`);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].name).toBe('sec');
  });

  it('handles quoted values', () => {
    const config = parseIntegrationsYaml(`
providers:
  - name: "quoted-name"
    command: 'npx server'
    tool: "run"
    every: 2
`);
    expect(config.providers[0].name).toBe('quoted-name');
    expect(config.providers[0].command).toBe('npx server');
  });

  it('returns empty for empty content', () => {
    const config = parseIntegrationsYaml('');
    expect(config.providers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toProposals
// ---------------------------------------------------------------------------

describe('toProposals', () => {
  it('converts MCP output to TicketProposal[]', () => {
    const result: IntegrationResult = {
      provider: 'test-provider',
      feed: 'proposals',
      data: {
        proposals: [
          {
            title: 'Fix SQL injection',
            description: 'Input not sanitized in auth module',
            files: ['src/auth.ts'],
            category: 'security',
            confidence: 85,
            impact: 9,
          },
        ],
      },
    };

    const proposals = toProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toBe('Fix SQL injection');
    expect(proposals[0].description).toBe('Input not sanitized in auth module');
    expect(proposals[0].category).toBe('security');
    expect(proposals[0].confidence).toBe(85);
    expect(proposals[0].impact_score).toBe(9);
    expect(proposals[0].files).toEqual(['src/auth.ts']);
    expect(proposals[0].allowed_paths).toEqual(['src/auth.ts']);
    expect(proposals[0].id).toMatch(/^integration-test-provider-/);
  });

  it('handles missing fields with defaults', () => {
    const result: IntegrationResult = {
      provider: 'basic',
      feed: 'proposals',
      data: {
        proposals: [{ title: 'Something' }],
      },
    };

    const proposals = toProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].confidence).toBe(50);
    expect(proposals[0].impact_score).toBe(5);
    expect(proposals[0].category).toBe('fix');
    expect(proposals[0].files).toEqual([]);
  });

  it('handles array directly (no wrapper object)', () => {
    const result: IntegrationResult = {
      provider: 'flat',
      feed: 'proposals',
      data: [
        { title: 'Finding 1', description: 'desc 1' },
        { title: 'Finding 2', description: 'desc 2' },
      ],
    };

    const proposals = toProposals(result);
    expect(proposals).toHaveLength(2);
  });

  it('returns empty for null data', () => {
    const result: IntegrationResult = {
      provider: 'empty',
      feed: 'proposals',
      data: null,
    };

    expect(toProposals(result)).toEqual([]);
  });

  it('returns empty for non-array proposals', () => {
    const result: IntegrationResult = {
      provider: 'bad',
      feed: 'proposals',
      data: { proposals: 'not an array' },
    };

    expect(toProposals(result)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toLearnings
// ---------------------------------------------------------------------------

describe('toLearnings', () => {
  it('stores learnings from MCP output', () => {
    // Set up learnings file directory
    const learningsDir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(learningsDir, { recursive: true });

    toLearnings(
      {
        learnings: [
          { text: 'Always use parameterized queries', category: 'pattern', tags: ['security'] },
          { text: 'Auth module is fragile', category: 'warning' },
        ],
      },
      tmpDir,
    );

    // Verify learnings were written
    const learningsPath = path.join(learningsDir, 'learnings.json');
    expect(fs.existsSync(learningsPath)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(learningsPath, 'utf-8'));
    expect(stored).toHaveLength(2);
    expect(stored[0].text).toBe('Always use parameterized queries');
    expect(stored[1].text).toBe('Auth module is fragile');
  });

  it('handles null data gracefully', () => {
    toLearnings(null, tmpDir);
    // No error thrown
  });

  it('handles array directly', () => {
    const learningsDir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(learningsDir, { recursive: true });

    toLearnings(
      [{ text: 'Direct array learning' }],
      tmpDir,
    );

    const learningsPath = path.join(learningsDir, 'learnings.json');
    expect(fs.existsSync(learningsPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toNudges
// ---------------------------------------------------------------------------

describe('toNudges', () => {
  it('stores nudges from MCP output', () => {
    const hintsDir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(hintsDir, { recursive: true });

    toNudges(
      {
        nudges: [
          { text: 'Focus on auth module' },
          'Simple string nudge',
        ],
      },
      tmpDir,
    );

    const hintsPath = path.join(hintsDir, 'hints.json');
    expect(fs.existsSync(hintsPath)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(hintsPath, 'utf-8'));
    expect(stored).toHaveLength(2);
    expect(stored[0].text).toBe('Focus on auth module');
    expect(stored[1].text).toBe('Simple string nudge');
  });

  it('handles null data gracefully', () => {
    toNudges(null, tmpDir);
    // No error thrown
  });
});

// ---------------------------------------------------------------------------
// Cadence logic
// ---------------------------------------------------------------------------

describe('runIntegrations cadence', () => {
  it('skips providers not matching phase', async () => {
    const config: IntegrationConfig = {
      providers: [
        {
          name: 'post-only',
          command: 'node server.js',
          tool: 'run',
          every: 1,
          phase: 'post-cycle',
          feed: 'proposals',
          timeout: 5000,
        },
      ],
    };

    const state = {
      cycleCount: 1,
      repoRoot: tmpDir,
      integrationLastRun: {},
      options: { verbose: false },
      displayAdapter: { log: () => {} },
    };

    // pre-scout phase should not invoke post-cycle provider
    const results = await runIntegrations(state, config, 'pre-scout');
    expect(results).toEqual([]);
  });

  it('respects every-N-cycles cadence', async () => {
    const config: IntegrationConfig = {
      providers: [
        {
          name: 'every5',
          command: 'node nonexistent.js',
          tool: 'run',
          every: 5,
          phase: 'pre-scout',
          feed: 'proposals',
          timeout: 1000,
        },
      ],
    };

    const state = {
      cycleCount: 3,
      repoRoot: tmpDir,
      integrationLastRun: { every5: 1 },
      options: { verbose: false },
      displayAdapter: { log: () => {} },
    };

    // Cycle 3, last run at 1, diff = 2 < 5 → skip
    const results = await runIntegrations(state, config, 'pre-scout');
    expect(results).toEqual([]);
  });

  it('invokes when cadence is met (catches spawn error gracefully)', async () => {
    const config: IntegrationConfig = {
      providers: [
        {
          name: 'every5',
          command: 'node nonexistent-server-that-wont-start.js',
          tool: 'run',
          every: 5,
          phase: 'pre-scout',
          feed: 'proposals',
          timeout: 1000,
        },
      ],
    };

    const state = {
      cycleCount: 5,
      repoRoot: tmpDir,
      integrationLastRun: {},
      options: { verbose: false },
      displayAdapter: { log: () => {} },
    };

    // Cycle 5, last run 0, diff = 5 >= 5 → should attempt invocation
    // Will fail because the server doesn't exist, but shouldn't throw
    const results = await runIntegrations(state, config, 'pre-scout');
    // Error is caught, results empty
    expect(results).toEqual([]);
  });
});
