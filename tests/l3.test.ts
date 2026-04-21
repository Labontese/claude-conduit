import { describe, it, expect } from 'vitest';
import { ContextCompressor } from '../src/l3-compressor.js';

const make = (role: 'user' | 'assistant', content: string) => ({ role, content });

const longConversation = Array.from({ length: 20 }, (_, i) =>
  i % 2 === 0
    ? make('user', `Question ${i}: ${'What is the status of feature X? '.repeat(20)}`)
    : make('assistant', `Answer ${i}: ${'The feature is progressing well. '.repeat(20)}`),
);

describe('L3 — ContextCompressor', () => {
  // No API key in tests — uses sync fallback
  const compressor = new ContextCompressor('');

  it('does not compress when under threshold', async () => {
    const short = [make('user', 'hi'), make('assistant', 'hello')];
    const result = await compressor.compress(short, { triggerTokens: 8000 });
    expect(result.compressed).toBe(false);
    expect(result.messages).toHaveLength(2);
  });

  it('does not compress when few turns regardless of token count', async () => {
    const few = [make('user', 'x'.repeat(5000)), make('assistant', 'y'.repeat(5000))];
    const result = await compressor.compress(few, { triggerTokens: 100, keepRecentTurns: 4 });
    expect(result.compressed).toBe(false);
  });

  it('compresses long conversation', async () => {
    const result = await compressor.compress(longConversation, {
      triggerTokens: 100,
      keepRecentTurns: 2,
    });
    expect(result.compressed).toBe(true);
    expect(result.messages.length).toBeLessThan(longConversation.length);
  });

  it('keeps recent turns verbatim', async () => {
    const keepRecent = 3;
    const result = await compressor.compress(longConversation, {
      triggerTokens: 100,
      keepRecentTurns: keepRecent,
    });
    expect(result.compressed).toBe(true);
    // Last keepRecent messages preserved
    const lastOriginal = longConversation.slice(-keepRecent);
    const lastResult = result.messages.slice(-keepRecent);
    for (let i = 0; i < keepRecent; i++) {
      expect(lastResult[i].content).toBe(lastOriginal[i].content);
    }
  });

  it('stats.turns_before matches input', async () => {
    const result = await compressor.compress(longConversation, { triggerTokens: 100, keepRecentTurns: 2 });
    expect(result.stats.turns_before).toBe(longConversation.length);
  });

  it('stats.turns_after < turns_before when compressed', async () => {
    const result = await compressor.compress(longConversation, { triggerTokens: 100, keepRecentTurns: 2 });
    expect(result.stats.turns_after).toBeLessThan(result.stats.turns_before);
  });

  it('compression_ratio < 1 when compressed', async () => {
    const result = await compressor.compress(longConversation, { triggerTokens: 100, keepRecentTurns: 2 });
    expect(result.stats.compression_ratio).toBeLessThan(1);
  });

  it('compression_ratio = 1 when not compressed', async () => {
    const short = [make('user', 'hi'), make('assistant', 'hello')];
    const result = await compressor.compress(short);
    expect(result.stats.compression_ratio).toBe(1);
  });

  it('compressed messages array is valid (has role and content)', async () => {
    const result = await compressor.compress(longConversation, { triggerTokens: 100, keepRecentTurns: 2 });
    for (const m of result.messages) {
      expect(m).toHaveProperty('role');
      expect(m).toHaveProperty('content');
      expect(typeof m.content).toBe('string');
    }
  });

  it('summary message is inserted as user role', async () => {
    const result = await compressor.compress(longConversation, { triggerTokens: 100, keepRecentTurns: 2 });
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toContain('Compressed');
  });

  it('hasApiKey returns false without key', () => {
    expect(compressor.hasApiKey()).toBe(false);
  });

  it('hasApiKey returns true with key', () => {
    const c = new ContextCompressor('sk-test-key');
    expect(c.hasApiKey()).toBe(true);
  });

  it('tokens_before_estimate > tokens_after_estimate when compressed', async () => {
    const result = await compressor.compress(longConversation, { triggerTokens: 100, keepRecentTurns: 2 });
    expect(result.stats.tokens_before_estimate).toBeGreaterThan(result.stats.tokens_after_estimate);
  });
});
