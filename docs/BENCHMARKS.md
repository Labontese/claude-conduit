# Benchmarks

> **Status: targets, not yet measured.** The numbers on this page are design targets derived from the prompt caching behaviour of the Anthropic API and the architecture of the three Phase 1 layers. Formal benchmarks have not yet been run. This file will be updated with real data as measurements are collected.

---

## Methodology

When benchmarks are run, the procedure will be:

1. **Baseline** — send a set of representative requests to the Anthropic API *without* conduit. Record `input_tokens`, `output_tokens`, and `cost_usd` per request.
2. **Optimized** — send the same requests through `conduit_wrap_request`. Record the same fields plus `cache_read_input_tokens` and `cache_write_input_tokens` from the Anthropic response.
3. **Compare** — compute token reduction and cost reduction relative to baseline.
4. **Warm cache** — repeat each test scenario for at least 5 turns to allow cache hit rates to stabilize. The first turn of a new tool set or system prompt will always be a cache miss (write). Hit rates are meaningful only from turn 2 onward.

### Test scenarios

| Scenario | Messages | Tools | System prompt |
|---|---|---|---|
| Short chat | 2–4 | 0 | Short (< 1 024 tokens) |
| Agent loop | 10–20 | 10–20 | Long (2 000–8 000 tokens) |
| Tool-heavy agent | 8–12 | 50+ | Medium (1 000–3 000 tokens) |
| Code review | 6–10 | 5–10 | Long (4 000–10 000 tokens) |

---

## Design targets

These targets assume a warm cache (turn 3+ of a session) and a long system prompt.

| Metric | Target | Rationale |
|---|---|---|
| Input token reduction | ~85% | Tool schemas dominate input tokens in tool-heavy agents; caching the schema block eliminates re-sending ~60–70% of tokens each turn. System + message caching accounts for the remainder. |
| Cache hit rate | ~74% | Anthropic 5-minute cache TTL. Typical agent loops stay well within this window. |
| Cost reduction | ~70–80% | Cache read tokens are billed at 10% of the normal input price (Anthropic pricing as of April 2026). |
| Latency overhead | < 5 ms | `wrapRequest()` is a synchronous in-memory operation (deep clone + breakpoint injection). |

> **Why 85% and not 100%?** The first turn in a new session always sends full tokens (cache miss / write). Short system prompts under 1 024 tokens cannot be cached at all. Output tokens are never cached. The 85% figure applies to the *input* side after a warm cache for a long-context agent.

---

## Results (placeholder)

The table below will be filled in once the benchmark suite is run.

| Scenario | Baseline input tokens | Optimized input tokens | Token reduction | Cache hit rate | Baseline cost | Optimized cost | Cost reduction |
|---|---|---|---|---|---|---|---|
| Short chat | — | — | — | — | — | — | — |
| Agent loop | — | — | — | — | — | — | — |
| Tool-heavy agent | — | — | — | — | — | — | — |
| Code review | — | — | — | — | — | — | — |

---

## Running the benchmarks yourself

Once a benchmark script is added to the repo, the command will be:

```bash
npm run benchmark
```

This will:
1. Spin up a local conduit instance with a file-backed SQLite database.
2. Replay the four test scenarios against the Anthropic API.
3. Print a summary table and write raw results to `benchmark-results.json`.

An Anthropic API key with sufficient quota is required. Set `ANTHROPIC_API_KEY` before running.

---

## What conduit does NOT claim to optimize

- **Output tokens** — conduit does not truncate or compress model responses.
- **Latency to first token** — cache hits can slightly reduce time-to-first-token, but conduit adds no latency-specific optimizations.
- **Batch API pricing** — if you use Anthropic's Batch API, prompt caching and batch discounts stack, but conduit's cost estimates do not account for batch pricing.
