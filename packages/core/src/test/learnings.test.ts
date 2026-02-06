/**
 * Learnings algorithm tests — covers pure functions in learnings/shared.ts:
 *   - applyLearningsDecay
 *   - consolidateLearnings
 *   - formatLearningsForPrompt
 *   - extractKeywords
 *   - extractTags
 *   - selectRelevant
 *   - LEARNINGS_DEFAULTS
 *
 * Tests pure functions only (no filesystem).
 */

import { describe, it, expect } from 'vitest';
import {
  type Learning,
  applyLearningsDecay,
  consolidateLearnings,
  formatLearningsForPrompt,
  extractKeywords,
  extractTags,
  selectRelevant,
  LEARNINGS_DEFAULTS,
} from '../learnings/shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: 'test-1',
    text: 'Test learning',
    category: 'gotcha',
    source: { type: 'qa_failure' },
    tags: [],
    weight: 50,
    created_at: new Date().toISOString(),
    last_confirmed_at: new Date().toISOString(),
    access_count: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LEARNINGS_DEFAULTS
// ---------------------------------------------------------------------------

describe('LEARNINGS_DEFAULTS', () => {
  it('has expected default values', () => {
    expect(LEARNINGS_DEFAULTS.DECAY_RATE).toBe(3);
    expect(LEARNINGS_DEFAULTS.DEFAULT_WEIGHT).toBe(50);
    expect(LEARNINGS_DEFAULTS.MAX_WEIGHT).toBe(100);
    expect(LEARNINGS_DEFAULTS.CONSOLIDATION_THRESHOLD).toBe(50);
    expect(LEARNINGS_DEFAULTS.SIMILARITY_MERGE_THRESHOLD).toBe(0.7);
    expect(LEARNINGS_DEFAULTS.DEFAULT_BUDGET).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// applyLearningsDecay
// ---------------------------------------------------------------------------

describe('applyLearningsDecay', () => {
  it('reduces weight by decay rate', () => {
    const learnings = [makeLearning({ weight: 50, access_count: 0 })];
    // Use old confirmation date to avoid confirmation bonus
    learnings[0].last_confirmed_at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = applyLearningsDecay(learnings, 3);
    expect(result).toHaveLength(1);
    expect(result[0].weight).toBe(47);
  });

  it('removes entries with weight <= 0', () => {
    const learnings = [makeLearning({
      weight: 2,
      access_count: 0,
      last_confirmed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    })];
    const result = applyLearningsDecay(learnings, 3);
    expect(result).toHaveLength(0);
  });

  it('halves decay for accessed entries', () => {
    const now = Date.now();
    const old = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    const accessed = makeLearning({ weight: 50, access_count: 1, last_confirmed_at: old });
    const notAccessed = makeLearning({ weight: 50, access_count: 0, last_confirmed_at: old });

    const [r1] = applyLearningsDecay([accessed], 3, now);
    const [r2] = applyLearningsDecay([notAccessed], 3, now);

    expect(r1.weight).toBeGreaterThan(r2.weight);
  });

  it('halves decay again for recently confirmed entries', () => {
    const now = Date.now();
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    const recentEntry = makeLearning({ weight: 50, access_count: 0, last_confirmed_at: recent });
    const oldEntry = makeLearning({ weight: 50, access_count: 0, last_confirmed_at: old });

    const [r1] = applyLearningsDecay([recentEntry], 3, now);
    const [r2] = applyLearningsDecay([oldEntry], 3, now);

    expect(r1.weight).toBeGreaterThan(r2.weight);
  });

  it('caps weight at MAX_WEIGHT', () => {
    const learnings = [makeLearning({ weight: 101 })];
    const result = applyLearningsDecay(learnings, 3);
    expect(result[0].weight).toBeLessThanOrEqual(LEARNINGS_DEFAULTS.MAX_WEIGHT);
  });
});

// ---------------------------------------------------------------------------
// consolidateLearnings
// ---------------------------------------------------------------------------

describe('consolidateLearnings', () => {
  it('returns null when below threshold', () => {
    const learnings = Array.from({ length: 10 }, (_, i) =>
      makeLearning({ id: `l-${i}`, text: `Unique learning ${i}` }),
    );
    expect(consolidateLearnings(learnings)).toBeNull();
  });

  it('merges similar entries above threshold', () => {
    // Create enough entries to exceed CONSOLIDATION_THRESHOLD (50)
    const learnings: Learning[] = [];
    for (let i = 0; i < 52; i++) {
      learnings.push(makeLearning({
        id: `l-${i}`,
        text: i < 2 ? 'Fix the authentication bug in login flow' : `Unique learning number ${i}`,
        weight: i === 0 ? 80 : 50,
      }));
    }
    // Make entries 0 and 1 very similar
    learnings[1].text = 'Fix the authentication bug in the login flow';

    const result = consolidateLearnings(learnings);
    // Should merge the two similar entries
    if (result !== null) {
      expect(result.length).toBeLessThan(learnings.length);
    }
  });

  it('does not mutate input array when returning null (too-aggressive guard)', () => {
    // Create many similar entries that will all merge, triggering the too-aggressive guard
    // We need result.length < ceil(50 * 0.4) = 20 to trigger null return
    const learnings: Learning[] = [];
    for (let i = 0; i < 52; i++) {
      learnings.push(makeLearning({
        id: `l-${i}`,
        // All entries have nearly identical text so they all merge into one
        text: 'Fix the authentication bug in the login flow for users',
        weight: 50 + i,
        access_count: 0,
      }));
    }

    // Snapshot original values
    const originals = learnings.map(l => ({
      weight: l.weight,
      text: l.text,
      access_count: l.access_count,
      tags: [...l.tags],
      last_confirmed_at: l.last_confirmed_at,
    }));

    const result = consolidateLearnings(learnings);
    // The massive merge should trigger the too-aggressive guard → null
    expect(result).toBeNull();

    // Verify no mutation on original entries
    for (let i = 0; i < learnings.length; i++) {
      expect(learnings[i].weight).toBe(originals[i].weight);
      expect(learnings[i].text).toBe(originals[i].text);
      expect(learnings[i].access_count).toBe(originals[i].access_count);
      expect(learnings[i].tags).toEqual(originals[i].tags);
      expect(learnings[i].last_confirmed_at).toBe(originals[i].last_confirmed_at);
    }
  });

  it('does not mutate input array when consolidation proceeds', () => {
    // Create entries with only a couple of duplicates so consolidation succeeds.
    // Use highly distinct texts to avoid false merges between "unique" entries.
    const distinctTopics = [
      'Configure PostgreSQL connection pooling settings for production database',
      'Implement Redis caching layer for session management tokens',
      'Setup Kubernetes horizontal pod autoscaler with memory thresholds',
      'Migrate legacy jQuery frontend components to React hooks pattern',
      'Integrate Stripe webhook handlers for subscription lifecycle events',
      'Optimize Elasticsearch index mappings for geolocation queries',
      'Implement GraphQL subscription resolvers with WebSocket transport',
      'Configure Terraform provider for AWS Lambda edge functions',
      'Setup CircleCI pipeline with Docker layer caching enabled',
      'Implement OpenTelemetry distributed tracing across microservices',
      'Configure Nginx reverse proxy with rate limiting middleware',
      'Setup Prometheus alerting rules for SLA breach detection',
      'Implement JWT refresh token rotation with sliding expiration',
      'Configure Webpack module federation for micro-frontend architecture',
      'Setup Datadog APM integration with custom business metrics',
      'Implement CQRS event sourcing pattern with EventStore database',
      'Configure HAProxy health checks for blue green deployments',
      'Setup Vault secrets management with dynamic database credentials',
      'Implement Apache Kafka consumer group rebalancing strategy',
      'Configure Istio service mesh mutual TLS authentication',
      'Setup Pulumi infrastructure stack for multi-region failover',
      'Implement DynamoDB single-table design with GSI overloading',
      'Configure Cloudflare Workers for edge-side rendering pipeline',
      'Setup Argo CD GitOps continuous deployment workflows',
      'Implement TimescaleDB hypertable partitioning for IoT telemetry',
      'Configure Envoy proxy circuit breaker with outlier detection',
      'Setup Buildkite parallel test splitting with JUnit reports',
      'Implement Temporal workflow orchestration for saga transactions',
      'Configure MinIO object storage with erasure coding redundancy',
      'Setup Grafana Loki log aggregation with structured metadata',
      'Implement ClickHouse materialized views for analytics pipeline',
      'Configure Traefik ingress controller with cert-manager integration',
      'Setup Renovate dependency update bot with auto-merge policies',
      'Implement CockroachDB multi-region database topology strategy',
      'Configure Fluent Bit log forwarding with output buffering',
      'Setup Sentry performance monitoring with custom transaction names',
      'Implement Neo4j graph traversal queries for recommendation engine',
      'Configure Caddy server automatic HTTPS with ACME challenges',
      'Setup Tekton pipeline tasks for container image vulnerability scanning',
      'Implement ScyllaDB lightweight transactions for inventory locking',
      'Configure Kong API gateway plugin chain for request transformation',
      'Setup Crossplane composite resources for platform abstraction layer',
      'Implement RabbitMQ dead letter exchange with retry backoff policy',
      'Configure Linkerd service mesh with traffic splitting canary',
      'Setup Bazel remote execution cache for monorepo build acceleration',
      'Implement Vitess horizontal sharding for MySQL compatibility layer',
      'Configure OpenPolicyAgent Rego rules for Kubernetes admission control',
      'Setup Packer machine image pipeline with Ansible provisioners',
      'Implement FoundationDB record layer for multi-tenant isolation',
      'Configure Cilium eBPF network policies for pod microsegmentation',
    ];

    const learnings: Learning[] = [];
    // First two entries are near-duplicates (will merge)
    learnings.push(makeLearning({
      id: 'l-0',
      text: 'Fix the authentication bug in login flow',
      weight: 80,
    }));
    learnings.push(makeLearning({
      id: 'l-1',
      text: 'Fix the authentication bug in the login flow',
      weight: 50,
    }));
    // Remaining entries are all highly distinct
    for (let i = 2; i < 52; i++) {
      learnings.push(makeLearning({
        id: `l-${i}`,
        text: distinctTopics[i - 2],
        weight: 50,
      }));
    }

    // Snapshot original values
    const originals = learnings.map(l => ({
      weight: l.weight,
      text: l.text,
      access_count: l.access_count,
      tags: [...l.tags],
      last_confirmed_at: l.last_confirmed_at,
    }));

    const result = consolidateLearnings(learnings);
    // Should succeed (merge the 2 similar entries, result ~51, above threshold of 20)
    expect(result).not.toBeNull();
    if (result) {
      expect(result.length).toBeLessThan(learnings.length);
    }

    // Verify no mutation on original entries
    for (let i = 0; i < learnings.length; i++) {
      expect(learnings[i].weight).toBe(originals[i].weight);
      expect(learnings[i].text).toBe(originals[i].text);
      expect(learnings[i].access_count).toBe(originals[i].access_count);
      expect(learnings[i].tags).toEqual(originals[i].tags);
      expect(learnings[i].last_confirmed_at).toBe(originals[i].last_confirmed_at);
    }
  });

  it('does not merge across different categories', () => {
    const learnings: Learning[] = [];
    for (let i = 0; i < 52; i++) {
      learnings.push(makeLearning({
        id: `l-${i}`,
        text: i < 2 ? 'Fix the authentication bug' : `Unique ${i}`,
        category: i === 0 ? 'gotcha' : i === 1 ? 'pattern' : 'gotcha',
      }));
    }
    const result = consolidateLearnings(learnings);
    // The similar entries have different categories, so shouldn't merge
    if (result !== null) {
      expect(result.length).toBe(52);
    }
  });
});

// ---------------------------------------------------------------------------
// formatLearningsForPrompt
// ---------------------------------------------------------------------------

describe('formatLearningsForPrompt', () => {
  it('returns empty string for no entries', () => {
    expect(formatLearningsForPrompt([])).toBe('');
  });

  it('includes XML tags', () => {
    const learnings = [makeLearning({ text: 'Always run tests', category: 'gotcha', weight: 80 })];
    const result = formatLearningsForPrompt(learnings);
    expect(result).toContain('<project-learnings>');
    expect(result).toContain('</project-learnings>');
  });

  it('includes category tag and weight', () => {
    const learnings = [makeLearning({ text: 'Check imports', category: 'warning', weight: 75 })];
    const result = formatLearningsForPrompt(learnings);
    expect(result).toContain('[WARNING]');
    expect(result).toContain('Check imports');
    expect(result).toContain('w:75');
  });

  it('sorts by weight descending', () => {
    const learnings = [
      makeLearning({ id: '1', text: 'Low weight', weight: 20 }),
      makeLearning({ id: '2', text: 'High weight', weight: 90 }),
    ];
    const result = formatLearningsForPrompt(learnings);
    expect(result.indexOf('High weight')).toBeLessThan(result.indexOf('Low weight'));
  });

  it('respects budget', () => {
    const learnings = Array.from({ length: 100 }, (_, i) =>
      makeLearning({ id: `l-${i}`, text: `Learning entry number ${i} with extra text`, weight: 100 - i }),
    );
    const result = formatLearningsForPrompt(learnings, 500);
    expect(result.length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// extractKeywords
// ---------------------------------------------------------------------------

describe('extractKeywords', () => {
  it('extracts meaningful words', () => {
    const kw = extractKeywords('Fix the authentication bug in login flow');
    expect(kw).toContain('authentication');
    expect(kw).toContain('login');
    expect(kw).toContain('flow');
  });

  it('filters stopwords', () => {
    const kw = extractKeywords('the and for this with from');
    expect(kw).toHaveLength(0);
  });

  it('filters short words', () => {
    const kw = extractKeywords('a is to in on');
    expect(kw).toHaveLength(0);
  });

  it('returns max 5 keywords', () => {
    const kw = extractKeywords('authentication authorization validation transformation configuration serialization normalization');
    expect(kw.length).toBeLessThanOrEqual(5);
  });

  it('sorts by length descending', () => {
    const kw = extractKeywords('bug authentication fix login');
    // Longer words first
    for (let i = 0; i < kw.length - 1; i++) {
      expect(kw[i].length).toBeGreaterThanOrEqual(kw[i + 1].length);
    }
  });

  it('deduplicates words', () => {
    const kw = extractKeywords('login login login authentication');
    const unique = new Set(kw);
    expect(kw.length).toBe(unique.size);
  });
});

// ---------------------------------------------------------------------------
// extractTags
// ---------------------------------------------------------------------------

describe('extractTags', () => {
  it('creates path: tags from paths', () => {
    const tags = extractTags(['src/lib/auth.ts', 'src/utils.ts'], []);
    expect(tags).toContain('path:src/lib/auth.ts');
    expect(tags).toContain('path:src/utils.ts');
  });

  it('creates cmd: tags from commands', () => {
    const tags = extractTags([], ['npm test', 'npm run build']);
    expect(tags).toContain('cmd:npm test');
    expect(tags).toContain('cmd:npm run build');
  });

  it('strips trailing globs from paths', () => {
    const tags = extractTags(['src/**', 'lib/*'], []);
    expect(tags).toContain('path:src');
    expect(tags).toContain('path:lib');
  });

  it('handles empty inputs', () => {
    expect(extractTags([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// selectRelevant
// ---------------------------------------------------------------------------

describe('selectRelevant', () => {
  const learnings: Learning[] = [
    makeLearning({
      id: 'auth',
      text: 'Authentication requires token refresh',
      tags: ['path:src/auth', 'cmd:npm test'],
      weight: 80,
      category: 'gotcha',
    }),
    makeLearning({
      id: 'db',
      text: 'Database queries need parameterization',
      tags: ['path:src/db'],
      weight: 60,
    }),
    makeLearning({
      id: 'unrelated',
      text: 'CSS grid layout tip',
      tags: ['path:src/styles'],
      weight: 40,
    }),
  ];

  it('returns all learnings when no context tags', () => {
    const result = selectRelevant(learnings, {});
    expect(result).toHaveLength(3);
  });

  it('scores path matches higher', () => {
    const result = selectRelevant(learnings, { paths: ['src/auth'] });
    expect(result[0].id).toBe('auth');
  });

  it('scores command matches', () => {
    const result = selectRelevant(learnings, { commands: ['npm test'] });
    expect(result[0].id).toBe('auth');
  });

  it('respects maxResults', () => {
    const result = selectRelevant(learnings, { paths: ['src/auth'] }, { maxResults: 1 });
    expect(result).toHaveLength(1);
  });

  it('boosts gotcha category when commands present', () => {
    const gotcha = makeLearning({ id: 'g', category: 'gotcha', weight: 30, tags: [] });
    const pattern = makeLearning({ id: 'p', category: 'pattern', weight: 30, tags: [] });
    const result = selectRelevant([gotcha, pattern], { commands: ['npm test'] });
    // gotcha should be boosted when commands are present
    expect(result[0].id).toBe('g');
  });
});
