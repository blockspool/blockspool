/**
 * MCP integrations public API.
 *
 * Keeps existing import paths stable while implementation is split across
 * focused modules for config parsing, runtime invocation, and result mapping.
 */

export {
  DEFAULT_INTEGRATION_TIMEOUT_MS,
  INTEGRATION_FEEDS,
  INTEGRATION_PHASES,
  isIntegrationFeed,
  isIntegrationPhase,
  loadIntegrations,
  parseIntegrationsYaml,
  type IntegrationConfig,
  type IntegrationFeed,
  type IntegrationPhase,
  type IntegrationProvider,
  type IntegrationResult,
} from './integrations/config.js';

export {
  invokeProvider,
  runIntegrations,
} from './integrations/runtime.js';

export {
  toLearnings,
  toNudges,
  toProposals,
} from './integrations/adapters.js';
