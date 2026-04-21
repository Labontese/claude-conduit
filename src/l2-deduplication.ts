import { createHash } from 'node:crypto';
import { normaliseMessages, normaliseForHash, type MessageInput } from './input-adapters.js';

export interface DeduplicationResult {
  messages: ContentBlock[];
  stats: {
    blocks_total: number;
    blocks_deduplicated: number;
    tokens_saved_estimate: number;
    strategy_used: 'exact' | 'minhash' | 'mixed' | 'none';
  };
}

export interface ContentBlock {
  role: 'user' | 'assistant' | 'system';
  content: string;
  hash?: string;
  deduplicated?: boolean;
  ref?: string;
}

export type DedupeReturnMode = 'clean' | 'annotated';

export interface DedupeItemsOptions {
  threshold?: number;
  case_sensitive?: boolean;
  return?: DedupeReturnMode;
}

export interface DedupeItemsResult {
  items: Array<{ role: 'user' | 'assistant'; content: string }>;
  stats: DeduplicationResult['stats'];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function contentHash(text: string, caseSensitive: boolean): string {
  return sha256(normaliseForHash(text, caseSensitive));
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
    let usedExact = false;
    let usedMinhash = false;

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
        usedExact = true;
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
            usedMinhash = true;
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

    // Novas fynd (2026-04-21): tidigare kod skrev alltid "exact" så snart
    // en enda exakt match sågs, även om MinHash också triggats för andra
    // block. Nu rapporterar vi "mixed" när båda strategierna användes,
    // annars den som faktiskt löpte — eller "none" om inget dedupliceras.
    let strategyUsed: DeduplicationResult['stats']['strategy_used'];
    if (usedExact && usedMinhash) strategyUsed = 'mixed';
    else if (usedExact) strategyUsed = 'exact';
    else if (usedMinhash) strategyUsed = 'minhash';
    else strategyUsed = 'none';

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

  /**
   * Nova 2026-04-21: item-orienterad front för dedupe som matchar
   * Annas UX-audit. Accepterar `string[]` eller `{role,content}[]`
   * (strängar wrappas till role "user"), defaultar case-insensitive,
   * och kan returnera antingen "clean" (default — dubbletter
   * borttagna) eller "annotated" (kvar, markerade med ref-hash).
   *
   * Nuvarande `deduplicateMessages` lämnas orörd för BC — ny logik
   * lever här så alias-testerna kan verifiera båda ingångarna.
   */
  deduplicateItems(
    items: ReadonlyArray<MessageInput>,
    options: DedupeItemsOptions = {},
  ): DedupeItemsResult {
    const threshold = options.threshold ?? 0.97;
    const caseSensitive = options.case_sensitive ?? false;
    const returnMode: DedupeReturnMode = options.return ?? 'clean';

    const normalised = normaliseMessages(items);

    // Replikera deduplicate()-logiken men använd case-insensitive
    // hash när konfigurerat. Vi kan inte återanvända deduplicate()
    // rakt av eftersom den använder råtext som hash-nyckel.
    const annotated: ContentBlock[] = [];
    let deduped = 0;
    let tokensSaved = 0;
    let usedExact = false;
    let usedMinhash = false;

    const exactSeen = new Map<string, string>();
    const minHashSeen = new Map<string, { sig: number[]; ref: string }>();

    for (const block of normalised) {
      const hash = contentHash(block.content, caseSensitive);

      if (exactSeen.has(hash)) {
        annotated.push({
          role: block.role,
          content: `[duplicate of: ${exactSeen.get(hash)}]`,
          hash,
          deduplicated: true,
          ref: exactSeen.get(hash),
        });
        deduped++;
        tokensSaved += estimateTokens(block.content);
        usedExact = true;
        continue;
      }

      if (block.content.length > 100) {
        const sig = minHashSignature(block.content);
        let matched = false;

        for (const [ref, cached] of minHashSeen) {
          const similarity = jaccardEstimate(sig, cached.sig);
          if (similarity >= threshold) {
            annotated.push({
              role: block.role,
              content: `[near-duplicate (~${(similarity * 100).toFixed(0)}% similar) of: ${ref}]`,
              hash,
              deduplicated: true,
              ref,
            });
            deduped++;
            tokensSaved += estimateTokens(block.content);
            usedMinhash = true;
            matched = true;
            break;
          }
        }

        if (!matched) {
          minHashSeen.set(hash, { sig, ref: hash });
          exactSeen.set(hash, hash);
          annotated.push({ role: block.role, content: block.content, hash });
        }
      } else {
        exactSeen.set(hash, hash);
        annotated.push({ role: block.role, content: block.content, hash });
      }
    }

    let strategyUsed: DeduplicationResult['stats']['strategy_used'];
    if (usedExact && usedMinhash) strategyUsed = 'mixed';
    else if (usedExact) strategyUsed = 'exact';
    else if (usedMinhash) strategyUsed = 'minhash';
    else strategyUsed = 'none';

    const stats: DeduplicationResult['stats'] = {
      blocks_total: normalised.length,
      blocks_deduplicated: deduped,
      tokens_saved_estimate: tokensSaved,
      strategy_used: strategyUsed,
    };

    const outItems =
      returnMode === 'clean'
        ? annotated
            .filter((b) => !b.deduplicated)
            .map((b) => ({ role: b.role as 'user' | 'assistant', content: b.content }))
        : annotated.map((b) => ({ role: b.role as 'user' | 'assistant', content: b.content }));

    return { items: outItems, stats };
  }
}
