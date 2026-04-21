import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';

export interface HandoffContract {
  id: string;
  from_agent: string;
  to_agent: string;
  ts: number;
  task: string;
  relevant_context: string;
  expected_output: string;
  constraints: string[];
  prior_decisions: string[];
  open_questions: string[];
  raw_tokens: number;
  compressed_tokens: number;
  compression_ratio: number;
}

export interface HandoffResult {
  contract: HandoffContract;
  system_prompt: string;
}

const HANDOFF_SYSTEM = `You are a context compression specialist. Your job is to distill a conversation into a structured handoff contract for the next agent.

Extract and return a JSON object with exactly these fields:
- task: (string) One clear sentence describing what needs to be done
- relevant_context: (string) Key facts, file paths, decisions, constraints the next agent must know — be specific
- expected_output: (string) What the next agent should deliver when done
- constraints: (string[]) Hard constraints — things the next agent must not do or must respect
- prior_decisions: (string[]) Decisions already made that should not be re-litigated
- open_questions: (string[]) Unresolved questions the next agent may need to address

Be precise. The next agent will receive ONLY this contract — not the conversation. Omit greetings, filler, and repetition. Keep each field concise but complete.

Return only valid JSON. No markdown fences.`;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function syncFallback(
  fromAgent: string,
  toAgent: string,
  task: string,
  messages: Array<{ role: string; content: string }>,
): Omit<HandoffContract, 'id' | 'ts' | 'raw_tokens' | 'compressed_tokens' | 'compression_ratio'> {
  const contextLines = messages
    .slice(-6)
    .map((m) => `[${m.role}] ${m.content.slice(0, 200)}`)
    .join('\n');

  return {
    from_agent: fromAgent,
    to_agent: toAgent,
    task,
    relevant_context: contextLines,
    expected_output: 'Complete the described task',
    constraints: [],
    prior_decisions: [],
    open_questions: [],
  };
}

export class AgentHandoffCompressor {
  private client: Anthropic | null = null;
  private store = new Map<string, HandoffContract>();

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (key) {
      this.client = new Anthropic({ apiKey: key });
    }
  }

  async compress(params: {
    from_agent: string;
    to_agent: string;
    task: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    context_hint?: string;
    model?: string;
  }): Promise<HandoffResult> {
    const { from_agent, to_agent, task, messages, context_hint, model = 'claude-haiku-4-5-20251001' } = params;

    const rawText = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
    const rawTokens = estimateTokens(rawText);

    let extracted: Omit<HandoffContract, 'id' | 'ts' | 'raw_tokens' | 'compressed_tokens' | 'compression_ratio'>;

    if (this.client) {
      const hint = context_hint ? `\nAdditional context hint: ${context_hint}` : '';
      const userMessage = `From agent: ${from_agent}\nTo agent: ${to_agent}\nTask: ${task}${hint}\n\nConversation to compress:\n\n${rawText}`;

      try {
        const response = await this.client.messages.create({
          model,
          max_tokens: 1024,
          system: HANDOFF_SYSTEM,
          messages: [{ role: 'user', content: userMessage }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const parsed = JSON.parse(text) as Partial<HandoffContract>;

        extracted = {
          from_agent,
          to_agent,
          task: parsed.task ?? task,
          relevant_context: parsed.relevant_context ?? '',
          expected_output: parsed.expected_output ?? '',
          constraints: parsed.constraints ?? [],
          prior_decisions: parsed.prior_decisions ?? [],
          open_questions: parsed.open_questions ?? [],
        };
      } catch {
        extracted = syncFallback(from_agent, to_agent, task, messages);
      }
    } else {
      extracted = syncFallback(from_agent, to_agent, task, messages);
    }

    const contractText = JSON.stringify(extracted);
    const compressedTokens = estimateTokens(contractText);

    const contract: HandoffContract = {
      id: randomUUID(),
      ts: Date.now(),
      raw_tokens: rawTokens,
      compressed_tokens: compressedTokens,
      compression_ratio: Math.min(1, compressedTokens / Math.max(rawTokens, 1)),
      ...extracted,
    };

    this.store.set(contract.id, contract);

    const systemPrompt = this.buildSystemPrompt(contract);

    return { contract, system_prompt: systemPrompt };
  }

  fetch(id: string): HandoffContract | undefined {
    return this.store.get(id);
  }

  private buildSystemPrompt(c: HandoffContract): string {
    const lines = [
      `## Handoff from ${c.from_agent}`,
      '',
      `**Task:** ${c.task}`,
      '',
      `**Context:**`,
      c.relevant_context,
      '',
      `**Expected output:** ${c.expected_output}`,
    ];

    if (c.constraints.length > 0) {
      lines.push('', '**Constraints:**');
      for (const x of c.constraints) lines.push(`- ${x}`);
    }
    if (c.prior_decisions.length > 0) {
      lines.push('', '**Prior decisions (do not re-litigate):**');
      for (const x of c.prior_decisions) lines.push(`- ${x}`);
    }
    if (c.open_questions.length > 0) {
      lines.push('', '**Open questions to address:**');
      for (const x of c.open_questions) lines.push(`- ${x}`);
    }

    lines.push('', `---`, `*Handoff ID: ${c.id} — use conduit_fetch_handoff to retrieve full detail*`);

    return lines.join('\n');
  }
}
