import { describe, it, expect } from 'vitest';
import { LazyToolRegistry } from '../src/l1-tool-registry.js';
import { CacheOrchestrator } from '../src/l4-cache-orchestrator.js';
import { ObservabilityBus } from '../src/l6-observability.js';

describe('Integration — L1 + L4 + L6', () => {
  it('full flow: register tools, wrap request, record to observability', async () => {
    const registry = new LazyToolRegistry();
    registry.register({
      name: 'greet',
      description: 'Greet someone by name',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      handler: async ({ name }) => `Hello, ${name}!`,
    });

    const tools = registry.listAll().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: registry.describeTool(t.name)!.inputSchema,
    }));

    const orchestrator = new CacheOrchestrator();
    const request = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: 'You are a helpful assistant. '.repeat(100),
      messages: [
        { role: 'user' as const, content: 'msg 1' },
        { role: 'assistant' as const, content: 'resp 1' },
        { role: 'user' as const, content: 'msg 2' },
        { role: 'assistant' as const, content: 'resp 2' },
        { role: 'user' as const, content: 'msg 3' },
      ],
      tools,
    };

    const wrapped = orchestrator.wrapRequest(request);
    expect(wrapped.meta.cache_breakpoints).toBeGreaterThan(0);
    expect(wrapped.meta.optimizations_applied.length).toBeGreaterThan(0);

    const obs = new ObservabilityBus(':memory:');
    const sessionId = obs.getCurrentSessionId();
    obs.recordRequest({
      sessionId,
      model: request.model,
      inputTokens: wrapped.meta.input_tokens_after,
      outputTokens: 150,
      savedTokens: wrapped.meta.saved_tokens,
      baselineCostUsd: wrapped.meta.input_tokens_before * (3 / 1e6),
      costUsd: wrapped.meta.input_tokens_after * (3 / 1e6),
      optimizationsApplied: wrapped.meta.optimizations_applied,
    });

    const report = obs.getSessionReport();
    expect(report.requestCount).toBe(1);
    expect(report.totalSavedTokens).toBe(wrapped.meta.saved_tokens);

    const markdown = obs.formatReport(report);
    expect(markdown).toContain('conduit_report');

    const result = await registry.executeTool('greet', { name: 'Daniel' });
    expect(result).toBe('Hello, Daniel!');

    obs.close();
  });

  it('search finds tools registered before wrap', () => {
    const registry = new LazyToolRegistry();
    registry.registerMany([
      { name: 'read_file', description: 'Read a file', inputSchema: {}, handler: async () => null },
      { name: 'write_file', description: 'Write a file', inputSchema: {}, handler: async () => null },
      { name: 'list_dir', description: 'List directory contents', inputSchema: {}, handler: async () => [] },
    ]);
    const results = registry.searchTools('file');
    expect(results.length).toBe(2);
    expect(results.every((r) => !('inputSchema' in r))).toBe(true);
  });
});
