import { createHash } from 'node:crypto';

export interface DeduplicationResult {
  messages: ContentBlock[];
  stats: {
    blocks_total: number;
    blocks_deduplicated: number;
    tokens_saved_estimate: number;
    strategy_used: 'exact' | 'minhash' | 'none';
  };
}

export interface ContentBlock {
  role: 'user' | 'assistant' | 'system';
  content: string;
  hash?: string;
  deduplicated?: boolean;
  ref?: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// MinHash signature for Jaccard similarity estimation
function minHashSignature(text: string, numHashes = 128): number[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  // 3-shingles
  const shingles = new Set<string>();
  for (let i = 0; i < words.length - 2; i++) {
    shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  if (shingles.size === 0) {
    for (const w of words) shingles.add(w);
  }

  const sig: number[] = new Array(numHashes).fill(Infinity);
  for (const shingle of shingles) {
    for (let i = 0; i < numHashes; i++) {
      // Simple hash function: FNV-inspired with different seeds
      const seed = i * 2654435761;
      let h = seed;
      for (let j = 0; j < shingle.length; j++) {
        h = Math.imul(h ^ shingle.charCodeAt(j), 1540483477);
        h = (h >>> 13) ^ h;
      }
      h = Math.abs(h);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

function jaccardEstimate(sigA: number[], sigB: number[]): number {
  let matches = 0;
  for (let i = 0; i < sigA.length; i++) {
    if (sigA[i] === sigB[i]) matches++;
  }
  return matches / sigA.length;
}

export class SemanticDeduplicator {
  private exactCache = new Map<string, string>();
  private minHashCache = new Map<string, { sig: number[]; content: string }>();

  deduplicate(
    blocks: ContentBlock[],
    threshold = 0.97,
  ): DeduplicationResult {
    const result: ContentBlock[] = [];
    let deduped = 0;
    let tokensSaved = 0;
    let strategyUsed: 'exact' | 'minhash' | 'none' = 'none';

    // Reset caches for each call (stateless per request)
    const exactSeen = new Map<string, string>();
    const minHashSeen = new Map<string, { sig: number[]; ref: string }>();

    for (const block of blocks) {
      const hash = sha256(block.content);

      // Exact match
      if (exactSeen.has(hash)) {
        result.push({
          ...block,
          content: `[duplicate of: ${exactSeen.get(hash)}]`,
          hash,
          deduplicated: true,
          ref: exactSeen.get(hash),
        });
        deduped++;
        tokensSaved += estimateTokens(block.content);
        strategyUsed = 'exact';
        continue;
      }

      // MinHash approximate match
      if (block.content.length > 100) {
        const sig = minHashSignature(block.content);
        let matched = false;

        for (const [ref, cached] of minHashSeen) {
          const similarity = jaccardEstimate(sig, cached.sig);
          if (similarity >= threshold) {
            result.push({
              ...block,
              content: `[near-duplicate (~${(similarity * 100).toFixed(0)}% similar) of: ${ref}]`,
              hash,
              deduplicated: true,
              ref,
            });
            deduped++;
            tokensSaved += estimateTokens(block.content);
            strategyUsed = strategyUsed === 'exact' ? 'exact' : 'minhash';
            matched = true;
            break;
          }
        }

        if (!matched) {
          minHashSeen.set(hash, { sig, ref: hash });
          exactSeen.set(hash, hash);
          result.push({ ...block, hash });
        }
      } else {
        exactSeen.set(hash, hash);
        result.push({ ...block, hash });
      }
    }

    return {
      messages: result,
      stats: {
        blocks_total: blocks.length,
        blocks_deduplicated: deduped,
        tokens_saved_estimate: tokensSaved,
        strategy_used: strategyUsed,
      },
    };
  }

  // Deduplicate Anthropic messages array
  deduplicateMessages(
    messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }>,
    threshold = 0.97,
  ): {
    messages: typeof messages;
    stats: DeduplicationResult['stats'];
  } {
    const blocks: ContentBlock[] = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const result = this.deduplicate(blocks, threshold);

    return {
      messages: result.messages.map((b, i) => ({
        ...messages[i],
        content: b.deduplicated ? b.content : messages[i].content,
      })),
      stats: result.stats,
    };
  }
}
