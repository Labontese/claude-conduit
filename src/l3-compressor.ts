import Anthropic from '@anthropic-ai/sdk';

export interface CompressionResult {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  compressed: boolean;
  stats: {
    turns_before: number;
    turns_after: number;
    tokens_before_estimate: number;
    tokens_after_estimate: number;
    compression_ratio: number;
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function totalTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

const SUMMARY_SYSTEM = `You are a context compression assistant. Your job is to summarize a conversation history into a compact memory block.

Rules:
- Preserve: decisions made, file names and paths, code snippets (verbatim), error messages, open questions, key facts
- Remove: greetings, acknowledgements ("sure!", "great!"), repetition, filler phrases
- Format: bullet points grouped by topic
- Never invent information
- Output only the summary, no preamble`;

export class ContextCompressor {
  private client: Anthropic | null = null;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (key) {
      this.client = new Anthropic({ apiKey: key });
    }
  }

  async compress(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options: {
      triggerTokens?: number;
      keepRecentTurns?: number;
      model?: string;
    } = {},
  ): Promise<CompressionResult> {
    const { triggerTokens = 8000, keepRecentTurns = 4, model = 'claude-haiku-4-5-20251001' } = options;

    const tokensBefore = totalTokens(messages);

    // Don't compress if under threshold
    if (tokensBefore < triggerTokens || messages.length <= keepRecentTurns) {
      return {
        messages,
        compressed: false,
        stats: {
          turns_before: messages.length,
          turns_after: messages.length,
          tokens_before_estimate: tokensBefore,
          tokens_after_estimate: tokensBefore,
          compression_ratio: 1,
        },
      };
    }

    const toCompress = messages.slice(0, messages.length - keepRecentTurns);
    const toKeep = messages.slice(messages.length - keepRecentTurns);

    const summary = await this.summarize(toCompress, model);

    const summaryMessage: { role: 'user' | 'assistant'; content: string } = {
      role: 'user',
      content: `[Compressed conversation history]\n${summary}`,
    };

    const compressed = [summaryMessage, ...toKeep];
    const tokensAfter = totalTokens(compressed);

    return {
      messages: compressed,
      compressed: true,
      stats: {
        turns_before: messages.length,
        turns_after: compressed.length,
        tokens_before_estimate: tokensBefore,
        tokens_after_estimate: tokensAfter,
        compression_ratio: tokensAfter / tokensBefore,
      },
    };
  }

  private async summarize(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    model: string,
  ): Promise<string> {
    if (!this.client) {
      return this.syncFallback(messages);
    }

    const conversation = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: 1024,
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: `Summarize this conversation:\n\n${conversation}` }],
      });

      const block = response.content[0];
      return block.type === 'text' ? block.text : this.syncFallback(messages);
    } catch {
      return this.syncFallback(messages);
    }
  }

  // Fallback: extract key lines heuristically without API call
  private syncFallback(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): string {
    const lines: string[] = ['## Compressed history (no API key — heuristic summary)'];
    for (const m of messages) {
      const text = m.content.trim();
      // Take first 150 chars of each message as a hint
      const preview = text.length > 150 ? text.slice(0, 150) + '…' : text;
      lines.push(`- [${m.role}] ${preview}`);
    }
    return lines.join('\n');
  }

  hasApiKey(): boolean {
    return this.client !== null;
  }
}
