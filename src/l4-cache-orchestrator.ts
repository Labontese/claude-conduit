export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  system?: string | Array<{ type: string; text: string; cache_control?: { type: string } }>;
  messages: AnthropicMessage[];
  tools?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface CacheMeta {
  input_tokens_before: number;
  input_tokens_after: number;
  saved_tokens: number;
  saved_usd_estimated: number;
  optimizations_applied: string[];
  cache_breakpoints: number;
  notes: string[];
}

export interface WrappedRequest {
  request: AnthropicRequest;
  meta: CacheMeta;
}

const TOKEN_COSTS: Record<string, { input: number }> = {
  'claude-opus-4-7': { input: 15 / 1e6 },
  'claude-sonnet-4-6': { input: 3 / 1e6 },
  'claude-haiku-4-5': { input: 0.8 / 1e6 },
  default: { input: 3 / 1e6 },
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class CacheOrchestrator {
  wrapRequest(request: AnthropicRequest, disable: string[] = []): WrappedRequest {
    const skip = new Set(disable);
    const notes: string[] = [];
    const optimizations: string[] = [];
    let breakpoints = 0;

    const optimized: AnthropicRequest = JSON.parse(JSON.stringify(request));
    const tokensBefore = estimateTokens(JSON.stringify(request));

    if (!skip.has('cache_tools') && optimized.tools && optimized.tools.length > 0) {
      const lastTool = optimized.tools[optimized.tools.length - 1];
      (lastTool as Record<string, unknown>)['cache_control'] = { type: 'ephemeral' };
      optimizations.push('cache_tools');
      breakpoints++;
    }

    if (!skip.has('cache_system') && optimized.system) {
      if (typeof optimized.system === 'string') {
        const sysTokens = estimateTokens(optimized.system);
        if (sysTokens >= 1024) {
          optimized.system = [
            { type: 'text', text: optimized.system, cache_control: { type: 'ephemeral' } },
          ];
          optimizations.push('cache_system');
          breakpoints++;
        } else {
          notes.push('System prompt under 1024 token minimum — cache skipped');
        }
      } else if (Array.isArray(optimized.system)) {
        const last = optimized.system[optimized.system.length - 1];
        if (!last.cache_control) {
          last.cache_control = { type: 'ephemeral' };
          optimizations.push('cache_system');
          breakpoints++;
        }
      }
    }

    if (!skip.has('cache_messages') && optimized.messages.length >= 4) {
      const lastUser = [...optimized.messages].reverse().find((m) => m.role === 'user');
      if (lastUser) {
        if (typeof lastUser.content === 'string') {
          lastUser.content = [
            { type: 'text', text: lastUser.content, cache_control: { type: 'ephemeral' } },
          ];
        } else if (Array.isArray(lastUser.content)) {
          const last = lastUser.content[lastUser.content.length - 1];
          (last as Record<string, unknown>)['cache_control'] = { type: 'ephemeral' };
        }
        optimizations.push('cache_messages');
        breakpoints++;
      }
    }

    const tokensAfter = estimateTokens(JSON.stringify(optimized));
    const savedTokens = Math.max(0, tokensBefore - tokensAfter);
    const pricing = TOKEN_COSTS[request.model] ?? TOKEN_COSTS['default'];
    const savedUsd = savedTokens * pricing.input;

    return {
      request: optimized,
      meta: {
        input_tokens_before: tokensBefore,
        input_tokens_after: tokensAfter,
        saved_tokens: savedTokens,
        saved_usd_estimated: savedUsd,
        optimizations_applied: optimizations,
        cache_breakpoints: breakpoints,
        notes,
      },
    };
  }
}
