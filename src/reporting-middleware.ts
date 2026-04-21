import { ObservabilityBus } from './l6-observability.js';

/**
 * Reporting middleware — implicit auto-loggning av alla MCP-tool-anrop.
 *
 * Varje conduit_*-tool lindas med `withReporting(toolName, handler)` och
 * får då gratis en rad i L6 requests-tabellen per anrop. Det betyder att
 * dashboarden lyser upp utan att man behöver kalla `conduit_report`
 * explicit.
 *
 * Vi försöker extrahera meningsfulla metrics ur tool-resultatet:
 *   - `saved_tokens` från dedup/compress/handoff/wrap
 *   - `input_tokens` / `output_tokens` från wrap/compress
 *   - `cost_usd` / `baseline_cost_usd` beräknas från tokens (Haiku pricing)
 *
 * Om inget går att extrahera loggar vi ändå anropet med 0/0 tokens och
 * model "n/a" så dashboarden åtminstone visar aktivitet (tool_name + tid).
 *
 * Logging får aldrig hindra själva tool-anropet:
 *   - Om handler kastar → logga med error-kolumnen satt, kasta vidare.
 *   - Om logging själv kastar → svälj felet tyst (men skriv till stderr).
 */

// Haiku 4.5 pricing per 2026-04 (Anthropic docs)
const HAIKU_INPUT_PER_MTOK = 0.8; // USD
const HAIKU_OUTPUT_PER_MTOK = 4.0; // USD

export interface ExtractedMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  savedTokens?: number;
  costUsd?: number;
  baselineCostUsd?: number;
  optimizationsApplied?: string[];
}

/**
 * Tool-handlers returnerar ett MCP-text-wrapper-objekt:
 *   { content: [{ type: 'text', text: '<json-string>' }] }
 *
 * Vi parsar JSON:en och letar efter kända metric-nycklar. Alla försök är
 * best-effort — kan inget läsas returnerar vi bara model=n/a.
 */
export function extractMetrics(toolResult: unknown): ExtractedMetrics {
  const fallback: ExtractedMetrics = {
    model: 'n/a',
    inputTokens: 0,
    outputTokens: 0,
  };

  if (!toolResult || typeof toolResult !== 'object') return fallback;

  const envelope = toolResult as { content?: Array<{ type?: string; text?: string }> };
  const content = envelope.content?.[0];
  if (!content || content.type !== 'text' || typeof content.text !== 'string') {
    return fallback;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(content.text);
  } catch {
    // Inte JSON (t.ex. markdown-rapport eller fri text) — logga bara anropet.
    return fallback;
  }

  return mergeMetrics(fallback, payload);
}

function mergeMetrics(base: ExtractedMetrics, payload: unknown): ExtractedMetrics {
  if (!payload || typeof payload !== 'object') return base;

  const result = { ...base };
  const p = payload as Record<string, unknown>;

  // wrap_request → { request, meta: { input_tokens_before, input_tokens_after,
  //   saved_tokens, saved_usd_estimated, optimizations_applied } }
  if (isObject(p['meta'])) {
    const meta = p['meta'] as Record<string, unknown>;
    if (typeof meta['input_tokens_after'] === 'number') {
      result.inputTokens = meta['input_tokens_after'];
    }
    if (typeof meta['input_tokens_before'] === 'number') {
      const before = meta['input_tokens_before'];
      result.baselineCostUsd = (before / 1_000_000) * HAIKU_INPUT_PER_MTOK;
    }
    if (typeof meta['saved_tokens'] === 'number') {
      result.savedTokens = meta['saved_tokens'];
    }
    if (Array.isArray(meta['optimizations_applied'])) {
      result.optimizationsApplied = meta['optimizations_applied'] as string[];
    }
    // request.model kan finnas på översta nivån
    if (isObject(p['request']) && typeof (p['request'] as Record<string, unknown>)['model'] === 'string') {
      result.model = (p['request'] as Record<string, unknown>)['model'] as string;
    }
  }

  // deduplicate → { messages, stats: { tokens_saved_estimate, ... } }
  if (isObject(p['stats'])) {
    const stats = p['stats'] as Record<string, unknown>;
    if (typeof stats['tokens_saved_estimate'] === 'number') {
      result.savedTokens = (result.savedTokens ?? 0) + stats['tokens_saved_estimate'];
    }
    if (typeof stats['tokens_before_estimate'] === 'number') {
      const before = stats['tokens_before_estimate'] as number;
      result.baselineCostUsd = (before / 1_000_000) * HAIKU_INPUT_PER_MTOK;
    }
    if (typeof stats['tokens_after_estimate'] === 'number') {
      result.inputTokens = stats['tokens_after_estimate'] as number;
    }
  }

  // handoff → { contract: { raw_tokens, compressed_tokens, ... }, system_prompt }
  if (isObject(p['contract'])) {
    const contract = p['contract'] as Record<string, unknown>;
    if (
      typeof contract['raw_tokens'] === 'number' &&
      typeof contract['compressed_tokens'] === 'number'
    ) {
      const raw = contract['raw_tokens'] as number;
      const compressed = contract['compressed_tokens'] as number;
      result.inputTokens = compressed;
      result.savedTokens = Math.max(0, raw - compressed);
      result.baselineCostUsd = (raw / 1_000_000) * HAIKU_INPUT_PER_MTOK;
    }
  }

  // route_model → { model, tier, reasoning }
  if (typeof p['model'] === 'string') {
    result.model = p['model'] as string;
  }

  // Fyll i cost_usd baserat på extraherade tokens om ingen explicit kostnad finns.
  if (result.costUsd === undefined && (result.inputTokens > 0 || result.outputTokens > 0)) {
    result.costUsd =
      (result.inputTokens / 1_000_000) * HAIKU_INPUT_PER_MTOK +
      (result.outputTokens / 1_000_000) * HAIKU_OUTPUT_PER_MTOK;
  }

  return result;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Lindar en MCP-tool-handler så varje anrop auto-loggas till L6.
 *
 * Användning i index.ts:
 *   server.tool('conduit_foo', 'desc', schema, withReporting('conduit_foo', obs, sessionId, async (args) => { ... }));
 *
 * Handler-signaturen är `(args: A) => Promise<R>` där R är MCP-response-
 * envelope:en. Vi rör inte argumenten eller returvärdet — vi observerar
 * bara.
 */
export function withReporting<A, R>(
  toolName: string,
  obs: ObservabilityBus,
  sessionId: string,
  handler: (args: A) => Promise<R>,
): (args: A) => Promise<R> {
  return async (args: A): Promise<R> => {
    const startedAt = Date.now();
    try {
      const result = await handler(args);
      safeRecord(obs, sessionId, toolName, result, Date.now() - startedAt, null);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeRecord(obs, sessionId, toolName, null, Date.now() - startedAt, message);
      throw err;
    }
  };
}

function safeRecord(
  obs: ObservabilityBus,
  sessionId: string,
  toolName: string,
  result: unknown,
  latencyMs: number,
  error: string | null,
): void {
  try {
    const metrics = result === null ? fallbackMetrics() : extractMetrics(result);
    obs.recordRequest({
      sessionId,
      model: metrics.model,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      savedTokens: metrics.savedTokens,
      costUsd: metrics.costUsd,
      baselineCostUsd: metrics.baselineCostUsd,
      optimizationsApplied: metrics.optimizationsApplied,
      latencyMs,
      toolName,
      ...(error !== null ? { error } : {}),
    });
  } catch (e) {
    // Sista försvaret: om DB-skrivningen själv kraschar får den inte
    // ta med sig tool-anropet i fallet. Stderr-logga och gå vidare.
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error(`[conduit] reporting-middleware: failed to log ${toolName}: ${msg}`);
  }
}

function fallbackMetrics(): ExtractedMetrics {
  return { model: 'n/a', inputTokens: 0, outputTokens: 0 };
}
