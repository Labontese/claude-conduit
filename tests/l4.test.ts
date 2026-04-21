import { describe, it, expect } from 'vitest';
import { CacheOrchestrator } from '../src/l4-cache-orchestrator.js';

const makeRequest = (overrides = {}) => ({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  system: 'You are a helpful assistant. '.repeat(200),
  messages: [
    { role: 'user' as const, content: 'Hello' },
    { role: 'assistant' as const, content: 'Hi there' },
    { role: 'user' as const, content: 'How are you?' },
    { role: 'assistant' as const, content: 'Fine thanks' },
    { role: 'user' as const, content: 'Tell me about caching' },
  ],
  tools: [
    { name: 'tool_a', description: 'Tool A', input_schema: { type: 'object' } },
    { name: 'tool_b', description: 'Tool B', input_schema: { type: 'object' } },
  ],
  ...overrides,
});

describe('L4 — CacheOrchestrator', () => {
  const orchestrator = new CacheOrchestrator();

  it('returns request and meta', () => {
    const result = orchestrator.wrapRequest(makeRequest());
    expect(result).toHaveProperty('request');
    expect(result).toHaveProperty('meta');
  });

  it('meta has all required fields', () => {
    const { meta } = orchestrator.wrapRequest(makeRequest());
    expect(meta).toHaveProperty('input_tokens_before');
    expect(meta).toHaveProperty('input_tokens_after');
    expect(meta).toHaveProperty('saved_tokens');
    expect(meta).toHaveProperty('saved_usd_estimated');
    expect(meta).toHaveProperty('optimizations_applied');
    expect(meta).toHaveProperty('cache_breakpoints');
    expect(meta).toHaveProperty('notes');
  });

  it('adds cache_control to last tool', () => {
    const { request } = orchestrator.wrapRequest(makeRequest());
    const lastTool = request.tools![request.tools!.length - 1] as Record<string, unknown>;
    expect(lastTool['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('converts system string to array with cache_control when large enough', () => {
    const { request } = orchestrator.wrapRequest(makeRequest());
    expect(Array.isArray(request.system)).toBe(true);
    const sys = request.system as Array<Record<string, unknown>>;
    expect(sys[sys.length - 1]['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('does not cache system prompt under 1024 tokens', () => {
    const { meta } = orchestrator.wrapRequest(makeRequest({ system: 'Short prompt' }));
    expect(meta.notes.some((n: string) => n.includes('1024'))).toBe(true);
    expect(meta.optimizations_applied).not.toContain('cache_system');
  });

  it('adds cache_control to last user message when conversation is long', () => {
    const { request } = orchestrator.wrapRequest(makeRequest());
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    expect(lastUser).toBeDefined();
    const content = lastUser!.content;
    if (Array.isArray(content)) {
      const last = content[content.length - 1] as Record<string, unknown>;
      expect(last['cache_control']).toEqual({ type: 'ephemeral' });
    }
  });

  it('disable cache_tools skips tool caching', () => {
    const { meta } = orchestrator.wrapRequest(makeRequest(), ['cache_tools']);
    expect(meta.optimizations_applied).not.toContain('cache_tools');
  });

  it('disable cache_system skips system caching', () => {
    const { meta } = orchestrator.wrapRequest(makeRequest(), ['cache_system']);
    expect(meta.optimizations_applied).not.toContain('cache_system');
  });

  it('disable all skips all caching', () => {
    const { meta } = orchestrator.wrapRequest(makeRequest(), [
      'cache_tools',
      'cache_system',
      'cache_messages',
    ]);
    expect(meta.cache_breakpoints).toBe(0);
    expect(meta.optimizations_applied).toHaveLength(0);
  });

  it('does not cache messages when conversation is short', () => {
    const shortReq = makeRequest({ messages: [{ role: 'user' as const, content: 'hi' }] });
    const { meta } = orchestrator.wrapRequest(shortReq);
    expect(meta.optimizations_applied).not.toContain('cache_messages');
  });

  it('saved_usd_estimated is non-negative', () => {
    const { meta } = orchestrator.wrapRequest(makeRequest());
    expect(meta.saved_usd_estimated).toBeGreaterThanOrEqual(0);
  });

  it('optimizations_applied is array', () => {
    const { meta } = orchestrator.wrapRequest(makeRequest());
    expect(Array.isArray(meta.optimizations_applied)).toBe(true);
  });

  it('cache_breakpoints matches applied optimizations count', () => {
    const { meta } = orchestrator.wrapRequest(makeRequest());
    expect(meta.cache_breakpoints).toBe(meta.optimizations_applied.length);
  });

  it('does not mutate original request', () => {
    const req = makeRequest();
    const original = JSON.stringify(req);
    orchestrator.wrapRequest(req);
    expect(JSON.stringify(req)).toBe(original);
  });
});
