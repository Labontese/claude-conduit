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
 * Alias-kontrakt — Nova Fas 1 (2026-04-21).
 *
 * Verifierar att ett tool-anrop via gamla namnet ger samma output som
 * via det nya canonical-namnet. Testerna körs end-to-end genom handler-
 * funktionen (samma referens för alias + canonical, så resultatet är
 * deterministiskt likvärdigt per definition — men vi kör ändå båda för
 * att regressioner i input-normalisering inte ska gömmas).
 */

function buildDeps(): { deps: ConduitDeps; obs: ObservabilityBus } {
  const obs = new ObservabilityBus(':memory:');
  const sessionId = obs.startSession('alias-test', 'mcp-server');
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

function handlerOf(entries: ToolSurfaceEntry[], name: string) {
  const e = entries.find((x) => x.name === name);
  if (!e) throw new Error(`tool ${name} not found`);
  return e.handler;
}

function textOf(result: unknown): string {
  const env = result as { content: Array<{ type: string; text: string }> };
  return env.content[0].text;
}

describe('aliases — identical output between deprecated name and canonical', () => {
  let obs: ObservabilityBus;
  let entries: ToolSurfaceEntry[];

  beforeEach(() => {
    const built = buildDeps();
    obs = built.obs;
    entries = buildToolSurface(built.deps);
    // Seed registry so call_tool/execute_tool has something to dispatch to
    built.deps.registry.register({
      name: 'echo',
      description: 'Echo input',
      inputSchema: {},
      handler: async (args) => args,
    });
  });

  afterEach(() => obs.close());

  it('conduit_deduplicate preserves 0.3.0 behaviour (annotated, case-sensitive)', async () => {
    // Nova 2026-04-21: `conduit_deduplicate` behålls som separat handler
    // med 0.3.0-semantik. Jämförs INTE med `conduit_dedupe` eftersom
    // nya tool-et har andra defaults (case-insensitive, return=clean).
    const input = {
      messages: [
        { role: 'user' as const, content: 'hello' },
        { role: 'user' as const, content: 'hello' },
      ],
    };
    const result = await handlerOf(entries, 'conduit_deduplicate')(input);
    const parsed = JSON.parse(textOf(result));
    // 0.3.0-shape: `messages` array, duplicates retained as [duplicate of: ...]
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1].content).toContain('duplicate of');
    expect(parsed.stats.blocks_deduplicated).toBe(1);
  });

  it('conduit_deduplicate is case-sensitive (0.3.0 behaviour preserved)', async () => {
    const input = {
      messages: [
        { role: 'user' as const, content: 'Hello' },
        { role: 'user' as const, content: 'HELLO' },
      ],
    };
    const result = await handlerOf(entries, 'conduit_deduplicate')(input);
    const parsed = JSON.parse(textOf(result));
    // Case-sensitive → Hello and HELLO treated as distinct
    expect(parsed.stats.blocks_deduplicated).toBe(0);
  });

  it('conduit_compress == conduit_summarize_history', async () => {
    const input = {
      messages: [
        { role: 'user' as const, content: 'short' },
        { role: 'assistant' as const, content: 'also short' },
      ],
    };
    const a = await handlerOf(entries, 'conduit_compress')(input);
    const b = await handlerOf(entries, 'conduit_summarize_history')(input);
    expect(textOf(a)).toBe(textOf(b));
  });

  it('conduit_wrap_request == conduit_optimize_request', async () => {
    const input = {
      request: {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user' as const, content: 'hi' }],
      },
    };
    const a = await handlerOf(entries, 'conduit_wrap_request')(input);
    const b = await handlerOf(entries, 'conduit_optimize_request')(input);
    expect(textOf(a)).toBe(textOf(b));
  });

  it('conduit_report == conduit_cost_report (shared handler)', async () => {
    // Dessa tool-anrop auto-loggar via L6, så requestCount skiljer sig
    // mellan första och andra anropet inom samma session — byte-identisk
    // jämförelse bryts. Vi verifierar istället att handlers är samma
    // referens (garantin som faktiskt ger BC) och att båda returnerar
    // giltig JSON med samma nycklar.
    const reportEntry = entries.find((e) => e.name === 'conduit_report');
    const costEntry = entries.find((e) => e.name === 'conduit_cost_report');
    expect(reportEntry!.handler).toBe(costEntry!.handler);

    const a = JSON.parse(textOf(await handlerOf(entries, 'conduit_report')({ format: 'json' })));
    const b = JSON.parse(textOf(await handlerOf(entries, 'conduit_cost_report')({ format: 'json' })));
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it('conduit_explain == conduit_explain_request (shared handler)', async () => {
    // Samma motiv som ovan — explain-texten innehåller requestCount som
    // växer mellan anrop. Verifiera handler-identitet + strukturlikhet.
    const explainEntry = entries.find((e) => e.name === 'conduit_explain');
    const explainReqEntry = entries.find((e) => e.name === 'conduit_explain_request');
    expect(explainEntry!.handler).toBe(explainReqEntry!.handler);

    const a = textOf(await handlerOf(entries, 'conduit_explain')({}));
    const b = textOf(await handlerOf(entries, 'conduit_explain_request')({}));
    // Båda ska innehålla samma rubriker — räkneverk kan skilja.
    expect(a).toContain('Cache hit rate');
    expect(b).toContain('Cache hit rate');
    expect(a).toContain('token reduction');
    expect(b).toContain('token reduction');
  });

  it('conduit_rule_stats == conduit_optimization_stats', async () => {
    const input = { format: 'json' as const };
    const a = await handlerOf(entries, 'conduit_rule_stats')(input);
    const b = await handlerOf(entries, 'conduit_optimization_stats')(input);
    expect(textOf(a)).toBe(textOf(b));
  });

  it('conduit_handoff == conduit_handoff_pack', async () => {
    const input = {
      task: 'Build auth',
      messages: [
        { role: 'user' as const, content: 'Need JWT' },
        { role: 'assistant' as const, content: 'RS256 signing' },
      ],
      from_agent: 'emelie',
      to_agent: 'nova',
    };
    const a = await handlerOf(entries, 'conduit_handoff')(input);
    const b = await handlerOf(entries, 'conduit_handoff_pack')(input);
    // Raw ids differ per call — compare only the keys/shape
    const parseA = JSON.parse(textOf(a));
    const parseB = JSON.parse(textOf(b));
    expect(Object.keys(parseA).sort()).toEqual(Object.keys(parseB).sort());
    expect(parseA.contract.from_agent).toBe(parseB.contract.from_agent);
    expect(parseA.contract.task).toBe(parseB.contract.task);
  });

  it('conduit_ab_assign == conduit_ab_get_variant', async () => {
    // Seed an experiment
    const createHandler = handlerOf(entries, 'conduit_ab_create');
    await createHandler({
      name: 'exp1',
      variants: [
        { name: 'a', instruction: 'A' },
        { name: 'b', instruction: 'B' },
      ],
    });
    const input = { session_id: 'sess-1', experiment_name: 'exp1' };
    const a = await handlerOf(entries, 'conduit_ab_assign')(input);
    const b = await handlerOf(entries, 'conduit_ab_get_variant')(input);
    expect(textOf(a)).toBe(textOf(b));
  });

  it('conduit_execute_tool == conduit_call_tool', async () => {
    const input = { name: 'echo', args: { value: 42 } };
    const a = await handlerOf(entries, 'conduit_execute_tool')(input);
    const b = await handlerOf(entries, 'conduit_call_tool')(input);
    expect(textOf(a)).toBe(textOf(b));
  });

  it('conduit_fetch_handoff == conduit_handoff_load (miss case)', async () => {
    const input = { handoff_id: 'nonexistent' };
    const a = await handlerOf(entries, 'conduit_fetch_handoff')(input);
    const b = await handlerOf(entries, 'conduit_handoff_load')(input);
    expect(textOf(a)).toBe(textOf(b));
  });
});

describe('aliases — new input forms work on canonical names', () => {
  let obs: ObservabilityBus;
  let entries: ToolSurfaceEntry[];

  beforeEach(() => {
    const built = buildDeps();
    obs = built.obs;
    entries = buildToolSurface(built.deps);
  });

  afterEach(() => obs.close());

  it('conduit_dedupe accepts items: string[]', async () => {
    const handler = handlerOf(entries, 'conduit_dedupe');
    const result = await handler({ items: ['a', 'a', 'b'] });
    const parsed = JSON.parse(textOf(result));
    // "clean" default — duplicates removed
    expect(parsed.items.length).toBe(2);
    expect(parsed.stats.blocks_total).toBe(3);
    expect(parsed.stats.blocks_deduplicated).toBe(1);
  });

  it('conduit_dedupe case_sensitive=false merges Hello and HELLO', async () => {
    const handler = handlerOf(entries, 'conduit_dedupe');
    const result = await handler({ items: ['Hello', 'HELLO', 'hello'] });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.stats.blocks_deduplicated).toBe(2);
    expect(parsed.items.length).toBe(1);
  });

  it('conduit_dedupe case_sensitive=true keeps Hello and HELLO', async () => {
    const handler = handlerOf(entries, 'conduit_dedupe');
    const result = await handler({
      items: ['Hello', 'HELLO', 'hello'],
      case_sensitive: true,
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.stats.blocks_deduplicated).toBe(0);
    expect(parsed.items.length).toBe(3);
  });

  it('conduit_dedupe return="annotated" keeps duplicates with markers', async () => {
    const handler = handlerOf(entries, 'conduit_dedupe');
    const result = await handler({ items: ['x', 'x'], return: 'annotated' });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.items.length).toBe(2);
    expect(parsed.items[1].content).toContain('duplicate of');
  });

  it('conduit_dedupe return="clean" removes duplicates entirely', async () => {
    const handler = handlerOf(entries, 'conduit_dedupe');
    const result = await handler({ items: ['x', 'x', 'y', 'x'] });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.items.length).toBe(2);
    expect(parsed.items.map((i: { content: string }) => i.content)).toEqual(['x', 'y']);
  });

  it('conduit_summarize_history accepts items: string[] and compresses with preset', async () => {
    const handler = handlerOf(entries, 'conduit_summarize_history');
    // Build long enough to trigger aggressive preset (4000 tokens)
    const longItems = Array.from({ length: 20 }, (_, i) =>
      `message ${i}: ${'x'.repeat(1000)}`,
    );
    const result = await handler({ items: longItems, preset: 'aggressive' });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.compressed).toBe(true);
  });

  it('conduit_summarize_history preset "light" does not compress short input', async () => {
    const handler = handlerOf(entries, 'conduit_summarize_history');
    const result = await handler({
      items: ['short one', 'short two'],
      preset: 'light',
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.compressed).toBe(false);
  });

  it('conduit_summarize_history explicit trigger_tokens overrides preset', async () => {
    const handler = handlerOf(entries, 'conduit_summarize_history');
    const longItems = Array.from({ length: 10 }, (_, i) => `msg ${i}: ${'y'.repeat(200)}`);
    // preset="light" would normally NOT compress; explicit low trigger forces it
    const result = await handler({
      items: longItems,
      preset: 'light',
      trigger_tokens: 50,
      keep_recent_turns: 2,
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.compressed).toBe(true);
  });

  it('conduit_handoff_pack works with optional from_agent/to_agent', async () => {
    const handler = handlerOf(entries, 'conduit_handoff_pack');
    const result = await handler({
      task: 'Do the thing',
      messages: ['context line 1', 'context line 2'],
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.contract.task).toBe('Do the thing');
    expect(parsed.contract.from_agent).toBe('unknown');
    expect(parsed.contract.to_agent).toBe('unknown');
  });

  it('conduit_handoff_pack accepts messages: string[]', async () => {
    const handler = handlerOf(entries, 'conduit_handoff_pack');
    const result = await handler({
      task: 'Test',
      messages: ['plain string message', 'another one'],
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.contract).toBeDefined();
    expect(parsed.contract.raw_tokens).toBeGreaterThan(0);
  });

  it('conduit_optimize_request minimal form {model, messages}', async () => {
    const handler = handlerOf(entries, 'conduit_optimize_request');
    const result = await handler({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.request).toBeDefined();
    expect(parsed.request.model).toBe('claude-sonnet-4-6');
    expect(parsed.meta).toBeDefined();
  });

  it('conduit_optimize_request returns error for incomplete minimal form', async () => {
    const handler = handlerOf(entries, 'conduit_optimize_request');
    const result = await handler({ model: 'claude-sonnet-4-6' });
    const env = result as { isError?: boolean; content: Array<{ text: string }> };
    expect(env.isError).toBe(true);
    expect(env.content[0].text).toContain('requires');
  });
});
