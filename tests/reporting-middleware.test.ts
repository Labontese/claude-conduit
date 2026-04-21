import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ObservabilityBus } from '../src/l6-observability.js';
import { withReporting, extractMetrics } from '../src/reporting-middleware.js';

/**
 * Auto-reporting middleware — implicit loggning per tool-anrop.
 *
 * Dessa tester replikerar produktionsflödet: starta L6 mot in-memory DB,
 * linda dummy-handlers med `withReporting`, kör anrop, verifiera att rader
 * hamnar i `requests`-tabellen så dashboarden lyser upp utan att
 * `conduit_report` körts.
 */

type McpEnvelope = { content: Array<{ type: 'text'; text: string }> };

function envelope(obj: unknown): McpEnvelope {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

describe('reporting-middleware — implicit tool-loggning', () => {
  let obs: ObservabilityBus;
  let sessionId: string;

  beforeEach(() => {
    obs = new ObservabilityBus(':memory:');
    // Starta en dedikerad auto-reporting-session, precis som index.ts gör.
    sessionId = obs.startSession('saga-test', 'mcp-server');
  });

  afterEach(() => {
    obs.close();
  });

  it('loggar ett anrop per tool-exekvering', async () => {
    const handler = withReporting('test_tool', obs, sessionId, async () => envelope({ ok: true }));
    await handler({});
    await handler({});
    await handler({});

    const report = obs.getSessionReport(sessionId);
    expect(report.requestCount).toBe(3);
  });

  it('sparar tool_name i requests-tabellen', async () => {
    const handler = withReporting('conduit_demo', obs, sessionId, async () => envelope({ ok: true }));
    await handler({});

    const row = obs.getDb().prepare(`SELECT tool_name FROM requests WHERE session_id = ?`).get(sessionId) as
      | { tool_name: string }
      | undefined;
    expect(row?.tool_name).toBe('conduit_demo');
  });

  it('extraherar saved_tokens från dedup-resultat', async () => {
    const dedupResult = {
      messages: [],
      stats: {
        blocks_total: 3,
        blocks_deduplicated: 1,
        tokens_saved_estimate: 42,
        strategy_used: 'exact',
      },
    };
    const handler = withReporting('conduit_deduplicate', obs, sessionId, async () => envelope(dedupResult));
    await handler({});

    const report = obs.getSessionReport(sessionId);
    expect(report.totalSavedTokens).toBe(42);
  });

  it('extraherar metrics från wrap_request meta', async () => {
    const wrapResult = {
      request: { model: 'claude-sonnet-4-6' },
      meta: {
        input_tokens_before: 1000,
        input_tokens_after: 600,
        saved_tokens: 400,
        optimizations_applied: ['cache_tools', 'cache_system'],
      },
    };
    const handler = withReporting('conduit_wrap_request', obs, sessionId, async () => envelope(wrapResult));
    await handler({});

    const report = obs.getSessionReport(sessionId);
    expect(report.totalInputTokens).toBe(600);
    expect(report.totalSavedTokens).toBe(400);
    expect(report.totalBaselineCostUsd).toBeGreaterThan(0);
  });

  it('extraherar handoff-metrics (raw vs compressed tokens)', async () => {
    const handoffResult = {
      contract: {
        raw_tokens: 5000,
        compressed_tokens: 800,
      },
      system_prompt: '...',
    };
    const handler = withReporting('conduit_handoff', obs, sessionId, async () => envelope(handoffResult));
    await handler({});

    const report = obs.getSessionReport(sessionId);
    expect(report.totalInputTokens).toBe(800);
    expect(report.totalSavedTokens).toBe(4200);
  });

  it('loggar ändå när resultatet saknar metrics (tool_name räcker)', async () => {
    const handler = withReporting('conduit_search_tools', obs, sessionId, async () =>
      envelope([{ name: 'foo', description: 'bar' }]),
    );
    await handler({});

    const report = obs.getSessionReport(sessionId);
    expect(report.requestCount).toBe(1);

    const row = obs.getDb().prepare(`SELECT tool_name, model FROM requests WHERE session_id = ?`).get(sessionId) as
      | { tool_name: string; model: string }
      | undefined;
    expect(row?.tool_name).toBe('conduit_search_tools');
    expect(row?.model).toBe('n/a');
  });

  it('loggar fel utan att svälja det', async () => {
    const boom = new Error('boom');
    const handler = withReporting('conduit_fail', obs, sessionId, async () => {
      throw boom;
    });

    await expect(handler({})).rejects.toThrow('boom');

    const row = obs.getDb().prepare(`SELECT tool_name, error FROM requests WHERE session_id = ?`).get(sessionId) as
      | { tool_name: string; error: string }
      | undefined;
    expect(row?.tool_name).toBe('conduit_fail');
    expect(row?.error).toBe('boom');
  });

  it('mäter latency_ms > 0 för fördröjda handlers', async () => {
    const handler = withReporting('slow_tool', obs, sessionId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return envelope({ ok: true });
    });
    await handler({});

    const row = obs.getDb().prepare(`SELECT latency_ms FROM requests WHERE session_id = ?`).get(sessionId) as
      | { latency_ms: number }
      | undefined;
    expect(row?.latency_ms).toBeGreaterThanOrEqual(15);
  });

  it('extractMetrics är tolerant mot icke-JSON-text', () => {
    const metrics = extractMetrics({
      content: [{ type: 'text', text: '## markdown report\n| col |' }],
    });
    expect(metrics.model).toBe('n/a');
    expect(metrics.inputTokens).toBe(0);
  });

  it('ackumulerar över flera tools i samma session', async () => {
    const dedup = withReporting('conduit_deduplicate', obs, sessionId, async () =>
      envelope({ stats: { tokens_saved_estimate: 100 } }),
    );
    const handoff = withReporting('conduit_handoff', obs, sessionId, async () =>
      envelope({ contract: { raw_tokens: 1000, compressed_tokens: 200 } }),
    );
    await dedup({});
    await handoff({});

    const report = obs.getSessionReport(sessionId);
    expect(report.requestCount).toBe(2);
    expect(report.totalSavedTokens).toBe(100 + 800);
  });

  it('skriver en session-rad i sessions-tabellen som dashboarden kan JOINa mot', async () => {
    const handler = withReporting('conduit_demo', obs, sessionId, async () => envelope({ ok: true }));
    await handler({});

    const joined = obs
      .getDb()
      .prepare(
        `SELECT r.tool_name, s.agent_name
         FROM requests r JOIN sessions s ON s.id = r.session_id
         WHERE r.session_id = ?`,
      )
      .get(sessionId) as { tool_name: string; agent_name: string } | undefined;

    expect(joined?.tool_name).toBe('conduit_demo');
    expect(joined?.agent_name).toBe('saga-test');
  });
});
