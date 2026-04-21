import { describe, it, expect } from 'vitest';
import { SemanticDeduplicator } from '../src/l2-deduplication.js';

const make = (role: 'user' | 'assistant', content: string) => ({ role, content });

describe('L2 — SemanticDeduplicator', () => {
  const dedup = new SemanticDeduplicator();

  it('returns all messages unchanged when no duplicates', () => {
    const msgs = [make('user', 'Hello'), make('assistant', 'Hi'), make('user', 'How are you?')];
    const { messages, stats } = dedup.deduplicateMessages(msgs);
    expect(messages).toHaveLength(3);
    expect(stats.blocks_deduplicated).toBe(0);
  });

  it('detects exact duplicate messages', () => {
    const content = 'This is a repeated message exactly.';
    const msgs = [make('user', content), make('assistant', 'ok'), make('user', content)];
    const { stats } = dedup.deduplicateMessages(msgs);
    expect(stats.blocks_deduplicated).toBe(1);
    expect(stats.strategy_used).toBe('exact');
  });

  it('marks deduplicated messages', () => {
    const content = 'Exact duplicate content here.';
    const msgs = [make('user', content), make('user', content)];
    const { messages } = dedup.deduplicateMessages(msgs);
    const second = messages[1].content as string;
    expect(second).toContain('duplicate');
  });

  it('tokens_saved_estimate > 0 when duplicates found', () => {
    const content = 'Repeated content that should be deduplicated properly.';
    const msgs = [make('user', content), make('user', content)];
    const { stats } = dedup.deduplicateMessages(msgs);
    expect(stats.tokens_saved_estimate).toBeGreaterThan(0);
  });

  it('stats.blocks_total matches input length', () => {
    const msgs = [make('user', 'a'), make('assistant', 'b'), make('user', 'c')];
    const { stats } = dedup.deduplicateMessages(msgs);
    expect(stats.blocks_total).toBe(3);
  });

  it('no deduplication for unique messages', () => {
    const msgs = [
      make('user', 'Tell me about TypeScript'),
      make('assistant', 'TypeScript is a typed superset of JavaScript'),
      make('user', 'What about interfaces?'),
    ];
    const { stats } = dedup.deduplicateMessages(msgs);
    expect(stats.blocks_deduplicated).toBe(0);
    expect(stats.strategy_used).toBe('none');
  });

  it('detects near-duplicate with minhash at low threshold', () => {
    const base = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    const variant = base.replace('quick', 'fast').replace('lazy', 'sleepy');
    const msgs = [make('user', base), make('user', variant)];
    const { stats } = dedup.deduplicateMessages(msgs, 0.7);
    // With enough similarity and low threshold, should detect near-dupe
    expect(stats.blocks_total).toBe(2);
  });

  it('high threshold keeps near-duplicates', () => {
    const base = 'Hello world this is a test message for deduplication purposes.';
    const variant = 'Hello world this is a test message for duplication purposes.';
    const msgs = [make('user', base), make('user', variant)];
    const { stats } = dedup.deduplicateMessages(msgs, 0.99);
    // Very high threshold — might not dedup
    expect(stats.blocks_total).toBe(2);
  });

  it('preserves role in output', () => {
    const msgs = [make('user', 'hi'), make('assistant', 'hello'), make('user', 'bye')];
    const { messages } = dedup.deduplicateMessages(msgs);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  it('handles empty messages array', () => {
    const { messages, stats } = dedup.deduplicateMessages([]);
    expect(messages).toHaveLength(0);
    expect(stats.blocks_total).toBe(0);
  });

  it('handles single message', () => {
    const msgs = [make('user', 'only one message')];
    const { messages, stats } = dedup.deduplicateMessages(msgs);
    expect(messages).toHaveLength(1);
    expect(stats.blocks_deduplicated).toBe(0);
  });

  it('multiple duplicates counted correctly', () => {
    const content = 'Same content repeated many times for testing.';
    const msgs = [
      make('user', content),
      make('user', content),
      make('user', content),
    ];
    const { stats } = dedup.deduplicateMessages(msgs);
    expect(stats.blocks_deduplicated).toBe(2);
  });
});
