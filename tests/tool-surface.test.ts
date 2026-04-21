import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LazyToolRegistry } from '../src/l1-tool-registry.js';
import { SemanticDeduplicator } from '../src/l2-deduplication.js';
import { ContextCompressor } from '../src/l3-compressor.js';
import { CacheOrchestrator } from '../src/l4-cache-orchestrator.js';
import { ObservabilityBus } from '../src/l6-observability.js';
import { AgentHandoffCompressor } from '../src/l7-handoff.js';
import { FeedbackLoop } from '../src/l8-feedback.js';
import { ModelRouter } from '../src/l5-router.js';
import { ABTesting } from '../src/l5-ab-testing.js';
import { buildToolSurface, type ConduitDeps, type ToolSurfaceEntry } from '../src/tool-definitions.js';

/**
 * Tool-surface — Nova Fas 1 (2026-04-21).
 *
 * Verifierar att:
 *   1. Alla 10 omdöpta canonical tools finns
 *   2. Alla gamla namn lever kvar som aliases och markeras deprecated
 *   3. Canonical + alias delar handler (identisk referens)
 *   4. Varje alias routar till samma canonical-namn
 *
 * Denna suite testar bara tool-ytan. Funktionell likvärdighet mellan
 * alias och canonical verifieras separat i `aliases.test.ts`.
 */

function buildDeps(): { deps: ConduitDeps; obs: ObservabilityBus } {
  const obs = new ObservabilityBus(':memory:');
  const sessionId = obs.startSession('test', 'mcp-server');
  const deps: ConduitDeps = {
    registry: new LazyToolRegistry(),
    deduplicator: new SemanticDeduplicator(),
    compressor: new ContextCompressor(''),
    cacheOrchestrator: new CacheOrchestrator(),
    obs,
    handoff: new AgentHandoffCompressor(''),
    feedback: new FeedbackLoop(obs.getDb()),
    router: new ModelRouter(),
    ab: new ABTesting(obs.getDb()),
    sessionId,
  };
  return { deps, obs };
}

function byName(entries: ToolSurfaceEntry[], name: string): ToolSurfaceEntry | undefined {
  return entries.find((e) => e.name === name);
}

describe('tool-surface — canonical names present', () => {
  let obs: ObservabilityBus;
  let entries: ToolSurfaceEntry[];

  beforeEach(() => {
    const built = buildDeps();
    obs = built.obs;
    entries = buildToolSurface(built.deps);
  });

  afterEach(() => obs.close());

  const canonicalNames = [
    // L1
    'conduit_search_tools',
    'conduit_describe_tool',
    'conduit_call_tool',
    // L4
    'conduit_optimize_request',
    // L6
    'conduit_cost_report',
    'conduit_explain_request',
    // L2
    'conduit_dedupe',
    // L3
    'conduit_summarize_history',
    // L7
    'conduit_handoff_pack',
    'conduit_handoff_load',
    // L8
    'conduit_feedback',
    'conduit_optimization_stats',
    // L5
    'conduit_route_model',
    'conduit_ab_create',
    'conduit_ab_get_variant',
    'conduit_ab_list',
  ];

  for (const name of canonicalNames) {
    it(`has canonical tool ${name} (not deprecated)`, () => {
      const entry = byName(entries, name);
      expect(entry, `missing canonical tool ${name}`).toBeDefined();
      expect(entry!.deprecated).toBe(false);
      expect(entry!.canonical).toBe(name);
    });
  }
});

describe('tool-surface — backwards-compatible aliases', () => {
  let obs: ObservabilityBus;
  let entries: ToolSurfaceEntry[];

  beforeEach(() => {
    const built = buildDeps();
    obs = built.obs;
    entries = buildToolSurface(built.deps);
  });

  afterEach(() => obs.close());

  const aliasMap: Record<string, string> = {
    conduit_execute_tool: 'conduit_call_tool',
    conduit_wrap_request: 'conduit_optimize_request',
    conduit_report: 'conduit_cost_report',
    conduit_explain: 'conduit_explain_request',
    conduit_deduplicate: 'conduit_dedupe',
    conduit_compress: 'conduit_summarize_history',
    conduit_handoff: 'conduit_handoff_pack',
    conduit_fetch_handoff: 'conduit_handoff_load',
    conduit_rule_stats: 'conduit_optimization_stats',
    conduit_ab_assign: 'conduit_ab_get_variant',
  };

  for (const [alias, canonical] of Object.entries(aliasMap)) {
    it(`alias ${alias} points to ${canonical}, is deprecated`, () => {
      const entry = byName(entries, alias);
      expect(entry, `missing alias ${alias}`).toBeDefined();
      expect(entry!.deprecated).toBe(true);
      expect(entry!.canonical).toBe(canonical);
      expect(entry!.description.toUpperCase()).toContain('DEPRECATED');
    });

    it(`alias ${alias} shares handler with ${canonical}`, () => {
      const aliasEntry = byName(entries, alias);
      const canonicalEntry = byName(entries, canonical);
      expect(aliasEntry!.handler).toBe(canonicalEntry!.handler);
    });
  }

  it('has exactly 10 deprecated aliases in Fas 1', () => {
    const deprecated = entries.filter((e) => e.deprecated);
    expect(deprecated).toHaveLength(10);
  });

  it('total tool count = 16 canonical + 10 aliases = 26', () => {
    expect(entries).toHaveLength(26);
  });
});

describe('tool-surface — uniqueness', () => {
  let obs: ObservabilityBus;

  afterEach(() => obs?.close());

  it('no duplicate tool names', () => {
    const built = buildDeps();
    obs = built.obs;
    const entries = buildToolSurface(built.deps);
    const names = entries.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
