/**
 * MCP Integrations — invoke external MCP servers on cadence during spin.
 *
 * Reads `.promptwheel/integrations.yaml` for provider definitions,
 * spawns each provider's MCP server via stdio transport, calls the
 * configured tool, and converts results into proposals / learnings / nudges.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { TicketProposal } from '@promptwheel/core/scout';
import { addLearning } from './learnings.js';
import { addHint } from './solo-hints.js';

const _require = createRequire(import.meta.url);
const CLI_VERSION: string = _require('../../package.json').version;

// ── Types ───────────────────────────────────────────────────────────────────

export interface IntegrationProvider {
  name: string;
  /** MCP server launch command (e.g. "npx @securitychecks/mcp-server") */
  command: string;
  /** Tool name to call on the MCP server */
  tool: string;
  /** Arguments passed to the tool call */
  args?: Record<string, unknown>;
  /** Invoke every N spin cycles */
  every: number;
  /** When in the cycle to invoke */
  phase: 'pre-scout' | 'post-cycle';
  /** How to inject results */
  feed: 'proposals' | 'learnings' | 'nudges';
  /** Timeout in ms (default 60000) */
  timeout?: number;
}

export interface IntegrationConfig {
  providers: IntegrationProvider[];
}

export interface IntegrationResult {
  provider: string;
  feed: 'proposals' | 'learnings' | 'nudges';
  data: unknown;
}

// ── Config loading ──────────────────────────────────────────────────────────

const VALID_PHASES = new Set(['pre-scout', 'post-cycle']);
const VALID_FEEDS = new Set(['proposals', 'learnings', 'nudges']);

/**
 * Load integrations config from `.promptwheel/integrations.yaml`.
 * Returns `{ providers: [] }` if the file doesn't exist (opt-in feature).
 */
export function loadIntegrations(repoRoot: string): IntegrationConfig {
  const yamlPath = path.join(repoRoot, '.promptwheel', 'integrations.yaml');
  if (!fs.existsSync(yamlPath)) {
    const ymlPath = path.join(repoRoot, '.promptwheel', 'integrations.yml');
    if (!fs.existsSync(ymlPath)) {
      return { providers: [] };
    }
    return parseIntegrationsYaml(fs.readFileSync(ymlPath, 'utf-8'));
  }
  return parseIntegrationsYaml(fs.readFileSync(yamlPath, 'utf-8'));
}

/**
 * Parse the integrations YAML file into typed config.
 *
 * Expects a `providers:` top-level key with a list of provider objects.
 * Uses line-by-line parsing (no external YAML library dependency).
 */
export function parseIntegrationsYaml(content: string): IntegrationConfig {
  const providers: IntegrationProvider[] = [];
  const lines = content.split('\n');

  let inProviders = false;
  let current: Partial<IntegrationProvider> | null = null;
  let inArgs = false;
  let args: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Top-level key
    if (/^providers\s*:/.test(trimmed)) {
      inProviders = true;
      continue;
    }

    if (!inProviders) continue;

    // New provider entry (starts with "- ")
    if (/^\s*-\s+\w+/.test(line)) {
      // Flush previous provider
      if (current) {
        if (Object.keys(args).length > 0) current.args = args;
        const validated = validateProvider(current);
        if (validated) providers.push(validated);
      }
      current = {};
      args = {};
      inArgs = false;

      // Parse "- key: value" on the same line
      const match = trimmed.match(/^-\s+(\w+)\s*:\s*(.*)/);
      if (match) {
        setProviderField(current, match[1], match[2].trim());
      }
      continue;
    }

    // Inside a provider object
    if (current) {
      // Check for args sub-object
      if (/^\s+args\s*:/.test(line) && !trimmed.startsWith('-')) {
        inArgs = true;
        // Check for inline value like "args: {}"
        const inlineMatch = trimmed.match(/^args\s*:\s*(.+)/);
        if (inlineMatch && inlineMatch[1].trim() !== '') {
          // Simple inline value — skip, args will stay empty
          inArgs = false;
        }
        continue;
      }

      // Inside args sub-object
      if (inArgs && /^\s{4,}\w/.test(line)) {
        const argMatch = trimmed.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
        if (argMatch) {
          args[argMatch[1]] = parseYamlValue(argMatch[2].trim());
        }
        continue;
      }

      // Regular provider field
      if (/^\s+\w/.test(line) && !trimmed.startsWith('-')) {
        inArgs = false;
        const fieldMatch = trimmed.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
        if (fieldMatch) {
          setProviderField(current, fieldMatch[1], fieldMatch[2].trim());
        }
        continue;
      }
    }

    // If we hit a non-indented line that isn't a provider, stop
    if (!line.startsWith(' ') && !line.startsWith('\t') && !trimmed.startsWith('-')) {
      inProviders = false;
    }
  }

  // Flush last provider
  if (current) {
    if (Object.keys(args).length > 0) current.args = args;
    const validated = validateProvider(current);
    if (validated) providers.push(validated);
  }

  return { providers };
}

function setProviderField(provider: Partial<IntegrationProvider>, key: string, value: string): void {
  switch (key) {
    case 'name': provider.name = unquote(value); break;
    case 'command': provider.command = unquote(value); break;
    case 'tool': provider.tool = unquote(value); break;
    case 'every': provider.every = parseInt(value, 10); break;
    case 'phase': provider.phase = unquote(value) as IntegrationProvider['phase']; break;
    case 'feed': provider.feed = unquote(value) as IntegrationProvider['feed']; break;
    case 'timeout': provider.timeout = parseInt(value, 10); break;
  }
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseYamlValue(s: string): unknown {
  const unquoted = unquote(s);
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (unquoted === 'null') return null;
  const num = Number(unquoted);
  if (!Number.isNaN(num) && unquoted !== '') return num;
  return unquoted;
}

function validateProvider(p: Partial<IntegrationProvider>): IntegrationProvider | null {
  if (!p.name || !p.command || !p.tool) return null;
  if (!p.every || p.every < 1) return null;
  if (p.phase && !VALID_PHASES.has(p.phase)) return null;
  if (p.feed && !VALID_FEEDS.has(p.feed)) return null;

  return {
    name: p.name,
    command: p.command,
    tool: p.tool,
    args: p.args,
    every: p.every,
    phase: p.phase ?? 'pre-scout',
    feed: p.feed ?? 'proposals',
    timeout: p.timeout ?? 60_000,
  };
}

// ── Runtime invocation ──────────────────────────────────────────────────────

interface IntegrationState {
  cycleCount: number;
  repoRoot: string;
  integrationLastRun: Record<string, number>;
  options: { verbose?: boolean };
  displayAdapter: { log(msg: string): void };
}

/**
 * Run all integrations matching the given phase.
 * Checks cadence (every N cycles) and invokes each due provider.
 */
export async function runIntegrations(
  state: IntegrationState,
  config: IntegrationConfig,
  phase: 'pre-scout' | 'post-cycle',
): Promise<IntegrationResult[]> {
  if (config.providers.length === 0) return [];

  const due = config.providers.filter(p => {
    if (p.phase !== phase) return false;
    const lastRun = state.integrationLastRun[p.name] ?? 0;
    return (state.cycleCount - lastRun) >= p.every;
  });

  if (due.length === 0) return [];

  const results: IntegrationResult[] = [];

  for (const provider of due) {
    try {
      if (state.options.verbose) {
        state.displayAdapter.log(`  Integration: invoking ${provider.name} (${provider.tool})`);
      }

      const data = await invokeProvider(provider, state.repoRoot);
      state.integrationLastRun[provider.name] = state.cycleCount;

      if (data !== null) {
        results.push({ provider: provider.name, feed: provider.feed, data });

        // Apply non-proposal feeds immediately
        if (provider.feed === 'learnings') {
          toLearnings(data, state.repoRoot);
        } else if (provider.feed === 'nudges') {
          toNudges(data, state.repoRoot);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (state.options.verbose) {
        state.displayAdapter.log(`  Integration: ${provider.name} failed — ${msg}`);
      }
      // Don't crash the spin loop
    }
  }

  return results;
}

/**
 * Invoke a single integration provider:
 * spawn MCP server, connect, call tool, disconnect.
 */
export async function invokeProvider(
  provider: IntegrationProvider,
  repoRoot: string,
): Promise<unknown> {
  // Dynamic import to avoid hard dependency on @modelcontextprotocol/sdk
  // (it's available in the monorepo but not a direct dependency of @promptwheel/cli)
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const parts = provider.command.split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env as Record<string, string> },
  });

  const client = new Client(
    { name: 'promptwheel', version: CLI_VERSION },
    { capabilities: {} },
  );

  const timeoutMs = provider.timeout ?? 60_000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    // Connect with timeout
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Connection timeout (${timeoutMs}ms)`)), timeoutMs);
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);

    // Call the tool
    const toolArgs = { ...provider.args, repoRoot };
    const result = await Promise.race([
      client.callTool({ name: provider.tool, arguments: toolArgs }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Tool call timeout (${timeoutMs}ms)`)), timeoutMs);
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);

    // Extract data from result
    if (result.structuredContent) {
      return result.structuredContent;
    }
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    if (content && content.length > 0) {
      const textContent = content.find((c: { type: string }) => c.type === 'text');
      if (textContent && 'text' in textContent && textContent.text) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return textContent.text;
        }
      }
    }

    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try { await client.close(); } catch { /* best-effort cleanup */ }
  }
}

// ── Result adapters ─────────────────────────────────────────────────────────

/**
 * Convert raw MCP tool output to TicketProposal[].
 *
 * Expects the MCP tool to return:
 * ```json
 * { "proposals": [{ "title", "description", "files", "category", "confidence", "impact" }] }
 * ```
 */
export function toProposals(result: IntegrationResult): TicketProposal[] {
  const data = result.data as Record<string, unknown> | null;
  if (!data) return [];

  const raw = Array.isArray(data) ? data : (data.proposals as unknown[]);
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item, i) => ({
      id: `integration-${result.provider}-${Date.now()}-${i}`,
      title: String(item.title ?? `${result.provider} finding ${i + 1}`),
      description: String(item.description ?? ''),
      category: (item.category as TicketProposal['category']) ?? 'fix',
      confidence: typeof item.confidence === 'number' ? item.confidence : 50,
      impact_score: typeof item.impact === 'number' ? item.impact : (typeof item.impact_score === 'number' ? item.impact_score : 5),
      files: Array.isArray(item.files) ? item.files.map(String) : [],
      allowed_paths: Array.isArray(item.files) ? item.files.map(String) : (Array.isArray(item.allowed_paths) ? item.allowed_paths.map(String) : []),
      acceptance_criteria: Array.isArray(item.acceptance_criteria) ? item.acceptance_criteria.map(String) : [],
      verification_commands: Array.isArray(item.verification_commands) ? item.verification_commands.map(String) : [],
      rationale: String(item.rationale ?? item.description ?? ''),
      estimated_complexity: (item.estimated_complexity as TicketProposal['estimated_complexity']) ?? 'moderate',
    }));
}

/**
 * Convert raw MCP tool output to learnings and store them.
 *
 * Expects: `{ "learnings": [{ "text", "category"?, "tags"? }] }`
 */
export function toLearnings(data: unknown, repoRoot: string): void {
  if (!data || typeof data !== 'object') return;

  const obj = data as Record<string, unknown>;
  const raw = Array.isArray(obj) ? obj : (obj.learnings as unknown[]);
  if (!Array.isArray(raw)) return;

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const text = String(entry.text ?? '').slice(0, 200);
    if (!text) continue;

    addLearning(repoRoot, {
      text,
      category: (entry.category as 'pattern' | 'warning' | 'gotcha' | 'context') ?? 'context',
      source: { type: 'manual', detail: 'integration' },
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    });
  }
}

/**
 * Convert raw MCP tool output to nudges (hints) and store them.
 *
 * Expects: `{ "nudges": [{ "text" }] }` or `{ "nudges": ["text", ...] }`
 */
export function toNudges(data: unknown, repoRoot: string): void {
  if (!data || typeof data !== 'object') return;

  const obj = data as Record<string, unknown>;
  const raw = Array.isArray(obj) ? obj : (obj.nudges as unknown[]);
  if (!Array.isArray(raw)) return;

  for (const item of raw) {
    const text = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' ? String((item as Record<string, unknown>).text ?? '') : '');
    if (text) {
      addHint(repoRoot, text.slice(0, 500));
    }
  }
}
