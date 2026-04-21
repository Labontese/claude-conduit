/**
 * Input-adapters — normalisera string-vänliga inputs till interna strukturer.
 *
 * Bakgrund: Annas UX-audit (2026-04-21) visade att flera tools kräver
 * `{role, content}`-objekt även när användaren bara vill lämna en lista
 * av strängar. Denna modul wrappar om användarinput så interna klasser
 * (L2/L3/L7) kan behållas oförändrade — tool-ytan blir string-vänlig
 * men logiken rörs inte.
 *
 * Alla funktioner är rena (inga bieffekter).
 */

export type MessageRole = 'user' | 'assistant';

export interface NormalisedMessage {
  role: MessageRole;
  content: string;
}

export type MessageInput = string | { role?: MessageRole; content?: string };

/**
 * Konvertera `items: string[] | {role,content}[]` till en strikt
 * `{role, content: string}[]`. Strängar wrappas med role "user".
 *
 * Objekt utan explicit role faller tillbaka till "user". Objekt utan
 * content får tom sträng — anropande kod ansvarar för att filtrera
 * bort tomma om så önskas.
 */
export function normaliseMessages(items: ReadonlyArray<MessageInput>): NormalisedMessage[] {
  return items.map((item) => {
    if (typeof item === 'string') {
      return { role: 'user', content: item };
    }
    return {
      role: item.role ?? 'user',
      content: item.content ?? '',
    };
  });
}

/**
 * Case-insensitive hash-hjälpare — mappar "  Hello  " och "hello" till
 * samma nyckel. Används av dedupe för `case_sensitive: false`.
 */
export function normaliseForHash(content: string, caseSensitive: boolean): string {
  const trimmed = content.trim();
  return caseSensitive ? trimmed : trimmed.toLowerCase();
}

/**
 * Compress-presets — döljer magiska talen `trigger_tokens` och
 * `keep_recent_turns` bakom tre namngivna profiler. Explicit override
 * vinner fortfarande när satt.
 *
 * Värdena är kalibrerade så "balanced" matchar 0.3.0-defaults.
 */
export interface CompressPreset {
  triggerTokens: number;
  keepRecentTurns: number;
}

export const COMPRESS_PRESETS: Record<'aggressive' | 'balanced' | 'light', CompressPreset> = {
  aggressive: { triggerTokens: 4000, keepRecentTurns: 2 },
  balanced: { triggerTokens: 8000, keepRecentTurns: 4 },
  light: { triggerTokens: 16000, keepRecentTurns: 8 },
};

/**
 * Lös slutgiltiga compress-params: preset sätter defaults, explicit
 * trigger_tokens/keep_recent_turns vinner om satt.
 */
export function resolveCompressOptions(params: {
  preset?: 'aggressive' | 'balanced' | 'light';
  trigger_tokens?: number;
  keep_recent_turns?: number;
}): CompressPreset {
  const base = COMPRESS_PRESETS[params.preset ?? 'balanced'];
  return {
    triggerTokens: params.trigger_tokens ?? base.triggerTokens,
    keepRecentTurns: params.keep_recent_turns ?? base.keepRecentTurns,
  };
}
