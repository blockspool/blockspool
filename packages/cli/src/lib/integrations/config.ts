import * as fs from 'node:fs';
import * as path from 'node:path';

export const INTEGRATION_PHASES = ['pre-scout', 'post-cycle'] as const;
export const INTEGRATION_FEEDS = ['proposals', 'learnings', 'nudges'] as const;
export const DEFAULT_INTEGRATION_TIMEOUT_MS = 60_000;

const VALID_PHASES: ReadonlySet<IntegrationPhase> = new Set(INTEGRATION_PHASES);
const VALID_FEEDS: ReadonlySet<IntegrationFeed> = new Set(INTEGRATION_FEEDS);

export type IntegrationPhase = (typeof INTEGRATION_PHASES)[number];
export type IntegrationFeed = (typeof INTEGRATION_FEEDS)[number];

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
  phase: IntegrationPhase;
  /** How to inject results */
  feed: IntegrationFeed;
  /** Timeout in ms (default 60000) */
  timeout?: number;
}

export interface IntegrationConfig {
  providers: IntegrationProvider[];
}

export interface IntegrationResult {
  provider: string;
  feed: IntegrationFeed;
  data: unknown;
}

export function isIntegrationPhase(value: unknown): value is IntegrationPhase {
  return typeof value === 'string' && VALID_PHASES.has(value as IntegrationPhase);
}

export function isIntegrationFeed(value: unknown): value is IntegrationFeed {
  return typeof value === 'string' && VALID_FEEDS.has(value as IntegrationFeed);
}

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
    case 'phase': provider.phase = unquote(value) as IntegrationPhase; break;
    case 'feed': provider.feed = unquote(value) as IntegrationFeed; break;
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
  if (p.phase && !isIntegrationPhase(p.phase)) return null;
  if (p.feed && !isIntegrationFeed(p.feed)) return null;

  return {
    name: p.name,
    command: p.command,
    tool: p.tool,
    args: p.args,
    every: p.every,
    phase: p.phase ?? 'pre-scout',
    feed: p.feed ?? 'proposals',
    timeout: p.timeout ?? DEFAULT_INTEGRATION_TIMEOUT_MS,
  };
}
