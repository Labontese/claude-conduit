export type ModelTier = 'haiku' | 'sonnet' | 'opus';
export type RoutingPolicy = 'aggressive' | 'conservative' | 'off';

export interface RouteDecision {
  model: string;
  tier: ModelTier;
  confidence: number;
  reason: string;
  cost_per_1m_input: number;
}

const MODELS: Record<ModelTier, { id: string; cost: number }> = {
  haiku:  { id: 'claude-haiku-4-5-20251001', cost: 0.80 },
  sonnet: { id: 'claude-sonnet-4-6',         cost: 3.00 },
  opus:   { id: 'claude-opus-4-7',           cost: 15.00 },
};

const HAIKU_KEYWORDS = [
  'format', 'summarize', 'list', 'translate', 'classify', 'extract',
  'convert', 'rewrite', 'fix typo', 'rename', 'boilerplate', 'template',
  'echo', 'repeat', 'copy',
];

const OPUS_KEYWORDS = [
  'architect', 'design system', 'refactor entire', 'complex algorithm',
  'security audit', 'performance analysis', 'multi-file', 'codebase',
  'trade-off', 'strategy', 'review all', 'analyze dependencies',
];

function detectTier(text: string, policy: RoutingPolicy): { tier: ModelTier; reason: string; confidence: number } {
  if (policy === 'off') {
    return { tier: 'sonnet', reason: 'routing disabled', confidence: 1 };
  }

  const lower = text.toLowerCase();

  for (const kw of OPUS_KEYWORDS) {
    if (lower.includes(kw)) {
      return { tier: 'opus', reason: `task keyword: "${kw}"`, confidence: 0.75 };
    }
  }

  if (policy === 'conservative') {
    return { tier: 'sonnet', reason: 'conservative policy default', confidence: 0.9 };
  }

  // Aggressive: try haiku for simple tasks
  for (const kw of HAIKU_KEYWORDS) {
    if (lower.includes(kw)) {
      return { tier: 'haiku', reason: `simple task keyword: "${kw}"`, confidence: 0.7 };
    }
  }

  // Length heuristic: very short prompts → haiku
  if (text.length < 200) {
    return { tier: 'haiku', reason: 'short prompt heuristic', confidence: 0.6 };
  }

  // Long prompts with code → opus
  if (text.length > 4000 && (lower.includes('```') || lower.includes('function') || lower.includes('class '))) {
    return { tier: 'opus', reason: 'long prompt with code', confidence: 0.65 };
  }

  return { tier: 'sonnet', reason: 'default — no strong signal', confidence: 0.8 };
}

export class ModelRouter {
  route(
    prompt: string,
    policy: RoutingPolicy = 'conservative',
    forceModel?: string,
  ): RouteDecision {
    if (forceModel) {
      const tier = (Object.entries(MODELS).find(([, v]) => v.id === forceModel)?.[0] ?? 'sonnet') as ModelTier;
      return {
        model: forceModel,
        tier,
        confidence: 1,
        reason: 'force_model override',
        cost_per_1m_input: MODELS[tier].cost,
      };
    }

    const { tier, reason, confidence } = detectTier(prompt, policy);
    const m = MODELS[tier];
    return {
      model: m.id,
      tier,
      confidence,
      reason,
      cost_per_1m_input: m.cost,
    };
  }

  models(): typeof MODELS {
    return MODELS;
  }
}
