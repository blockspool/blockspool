import { createRequire } from 'node:module';
import { toLearnings, toNudges } from './adapters.js';
import {
  DEFAULT_INTEGRATION_TIMEOUT_MS,
  type IntegrationConfig,
  type IntegrationPhase,
  type IntegrationProvider,
  type IntegrationResult,
} from './config.js';

const _require = createRequire(import.meta.url);
const CLI_VERSION: string = _require('../../../package.json').version;

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
  phase: IntegrationPhase,
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

  const timeoutMs = provider.timeout ?? DEFAULT_INTEGRATION_TIMEOUT_MS;
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
