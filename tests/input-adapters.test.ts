import { describe, it, expect } from 'vitest';
import {
  normaliseMessages,
  normaliseForHash,
  resolveCompressOptions,
  COMPRESS_PRESETS,
} from '../src/input-adapters.js';

describe('input-adapters — normaliseMessages', () => {
  it('wraps strings to {role: "user", content}', () => {
    const out = normaliseMessages(['hello', 'world']);
    expect(out).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'world' },
    ]);
  });

  it('passes through {role, content} objects unchanged', () => {
    const out = normaliseMessages([{ role: 'assistant', content: 'hi' }]);
    expect(out).toEqual([{ role: 'assistant', content: 'hi' }]);
  });

  it('handles mixed input', () => {
    const out = normaliseMessages(['first', { role: 'assistant', content: 'second' }, 'third']);
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
  });

  it('defaults missing role to "user"', () => {
    const out = normaliseMessages([{ content: 'no role' }]);
    expect(out[0].role).toBe('user');
  });

  it('defaults missing content to empty string', () => {
    const out = normaliseMessages([{ role: 'user' }]);
    expect(out[0].content).toBe('');
  });

  it('returns empty array for empty input', () => {
    expect(normaliseMessages([])).toEqual([]);
  });
});

describe('input-adapters — normaliseForHash', () => {
  it('lowercases and trims when case_sensitive=false', () => {
    expect(normaliseForHash('  Hello  ', false)).toBe('hello');
  });

  it('only trims when case_sensitive=true', () => {
    expect(normaliseForHash('  Hello  ', true)).toBe('Hello');
  });

  it('treats same-text different-case as equal when insensitive', () => {
    expect(normaliseForHash('Hello', false)).toBe(normaliseForHash('HELLO', false));
  });

  it('treats same-text different-case as distinct when sensitive', () => {
    expect(normaliseForHash('Hello', true)).not.toBe(normaliseForHash('HELLO', true));
  });
});

describe('input-adapters — resolveCompressOptions', () => {
  it('defaults to "balanced" preset', () => {
    expect(resolveCompressOptions({})).toEqual(COMPRESS_PRESETS.balanced);
  });

  it('applies "aggressive" preset', () => {
    expect(resolveCompressOptions({ preset: 'aggressive' })).toEqual(COMPRESS_PRESETS.aggressive);
  });

  it('applies "light" preset', () => {
    expect(resolveCompressOptions({ preset: 'light' })).toEqual(COMPRESS_PRESETS.light);
  });

  it('explicit trigger_tokens overrides preset', () => {
    const out = resolveCompressOptions({ preset: 'aggressive', trigger_tokens: 999 });
    expect(out.triggerTokens).toBe(999);
    expect(out.keepRecentTurns).toBe(COMPRESS_PRESETS.aggressive.keepRecentTurns);
  });

  it('explicit keep_recent_turns overrides preset', () => {
    const out = resolveCompressOptions({ preset: 'light', keep_recent_turns: 1 });
    expect(out.keepRecentTurns).toBe(1);
    expect(out.triggerTokens).toBe(COMPRESS_PRESETS.light.triggerTokens);
  });

  it('presets are ordered: aggressive triggers earlier than balanced than light', () => {
    expect(COMPRESS_PRESETS.aggressive.triggerTokens).toBeLessThan(
      COMPRESS_PRESETS.balanced.triggerTokens,
    );
    expect(COMPRESS_PRESETS.balanced.triggerTokens).toBeLessThan(
      COMPRESS_PRESETS.light.triggerTokens,
    );
  });
});
