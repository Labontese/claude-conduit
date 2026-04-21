# Architecture

> How claude-conduit is structured internally — layers, request flow, and the SQLite schema behind the Observability Bus.

---

## System overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  MCP Client (Claude Code, agent, script)                            │
└────────────────────────────┬────────────────────────────────────────┘
                             │  MCP tool calls (stdio)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  claude-conduit (MCP server)                                        │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  L1           │  │  L2           │  │  L3           │             │
│  │  Lazy Tool    │  │  Semantic     │  │  Context      │             │
│  │  Registry     │  │  Deduplicator │  │  Compressor   │             │
│  │               │  │               │  │               │             │
│  │  search       │  │  exact hash   │  │  Haiku summ.  │             │
│  │  describe     │  │  MinHash sim. │  │  keep recent  │             │
│  │  execute      │  │               │  │  turns        │             │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  L4           │  │  L5           │  │  L6           │             │
│  │  Cache        │  │  Model Router │  │  Observ-      │             │
│  │  Orchestrator │  │  + A/B Tests  │  │  ability Bus  │             │
│  │               │  │               │  │               │             │
│  │  wrapRequest  │  │  route_model  │  │  SQLite       │             │
│  │  cache_control│  │  ab_create    │  │  reports      │             │
│  │               │  │  ab_assign    │  │  feedback     │             │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐                                 │
│  │  L7           │  │  L8           │                                │
│  │  Agent        │  │  Feedback     │                                │
│  │  Handoff      │  │  Loop         │                                │
│  │               │  │               │                                │
│  │  compress     │  │  recordFdbk   │                                │
│  │  fetch        │  │  rule stats   │                                │
│  │  system_prompt│  │  auto-disable │                                │
│  └──────────────┘  └──────────────┘                                 │
└─────────────────────────────────────────────────────────────────────┘
                             │  optimized request returned to client
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Client sends request to Anthropic API                              │
└─────────────────────────────────────────────────────────────────────┘
```

> ⚠️ **Note:** conduit does **not** sit in the HTTP path. It transforms request objects in memory and returns them. The client is responsible for the actual API call.

---

## Request flow

A typical optimized request follows this path:

```
0. (Optional) Agent calls conduit_route_model(prompt)
   └── L5 ModelRouter returns cheapest capable model ID

1. Agent builds Anthropic request (model, system, messages, tools)

2. (Optional) Agent calls conduit_dedupe(items)
   └── L2 SemanticDeduplicator removes exact / near-duplicate blocks

3. (Optional) Agent calls conduit_summarize_history(items)
   └── L3 ContextCompressor summarises old turns via Haiku, keeps recent N verbatim

4. Agent calls conduit_optimize_request(request)
   └── L4 CacheOrchestrator.wrapRequest()
       ├── Deep-clone the request (no mutation of original)
       ├── If tools present → inject cache_control on last tool      [breakpoint 1]
       ├── If system >= 1024 tokens → inject cache_control on system [breakpoint 2]
       ├── If messages.length >= 4 → inject cache_control on last
       │   user message content block                                [breakpoint 3]
       ├── Estimate token counts (before / after)
       └── Return { request: optimized, meta: CacheMeta }

5. Agent sends optimized request to Anthropic API

6. Anthropic responds with usage.cache_read_input_tokens etc.

7. Agent calls obs.recordRequest(record) with actual token counts
   └── L6 ObservabilityBus writes to SQLite

8. Agent calls conduit_cost_report / conduit_explain_request to inspect session
   └── L6 reads aggregated stats from SQLite

9. (Optional) Agent calls conduit_feedback(request_id, rating)
   └── L8 FeedbackLoop records rating; auto-disables bad rules

--- Agent handoff path ---

A. Outgoing agent calls conduit_handoff_pack(task, messages, [from, to])
   └── L7 AgentHandoffCompressor distils conversation → HandoffContract
       Returns: { contract, system_prompt }

B. Incoming agent loads system_prompt as its system context

C. Incoming agent calls conduit_handoff_load(id) to read full contract
```

---

## L1 — Lazy Tool Registry

> **Status:** Shipped ✦ Phase 1

The Lazy Tool Registry stores tool definitions in a `Map<string, ToolDefinition>` keyed by name. Tools are **not** serialized and sent to the model at startup — the agent fetches only what it needs, on demand.

<!-- ToolDefinition interface -->
```typescript
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}
```

**Why this matters:** A typical Claude Code session with 50+ tools registered can carry 30–50 k tokens of schema overhead per request if all tools are sent upfront. With L1, a search query costs ~20 tokens; a describe call for one tool costs ~200–800 tokens. The agent pays only for what it actually uses.

**Scoring:** `searchTools()` assigns relevance scores — 2 points for a name match, 1 point for a description match — then returns the top `maxResults` entries sorted descending.

---

## L4 — Cache Orchestrator

> **Status:** Shipped ✦ Phase 1

`CacheOrchestrator.wrapRequest()` follows Anthropic's prompt caching rules and injects breakpoints in the order that maximises reuse across turns.

### cache_control placement order

Anthropic evaluates cache breakpoints from the top of the context downward. Placing breakpoints where content is **stable across calls** gives the highest hit rate.

```
Request structure          Stability                  Action
─────────────────────────────────────────────────────────────
tools[]                    High (rarely changes)    → breakpoint on last tool
system                     High (rarely changes)    → breakpoint on system block
messages (history)         Medium (grows each turn) → breakpoint on last user msg
```

> 💡 **Tip:** Placing tools first ensures the schema block is cached even when the system prompt is short. Placing messages last avoids re-caching the entire history on every turn.

### Minimum sizes

| Optimization | Condition |
|---|---|
| `cache_tools` | `tools` array must be non-empty |
| `cache_system` | System prompt must be >= 1 024 tokens (Anthropic minimum) |
| `cache_messages` | Conversation must have >= 4 messages |

### Token estimation

conduit uses the heuristic `ceil(text.length / 4)` for token estimation. This is a fast approximation — actual Anthropic token counts will differ slightly. The `saved_tokens` and `saved_usd_estimated` fields in `CacheMeta` are estimates only.

### Pricing table (used for `saved_usd_estimated`)

| Model | Input (per 1M tokens) |
|---|---|
| `claude-opus-4-7` | $15.00 |
| `claude-sonnet-4-6` | $3.00 |
| `claude-haiku-4-5` | $0.80 |
| (unknown model) | $3.00 |

---

## L6 — Observability Bus

> **Status:** Shipped ✦ Phase 1

The Observability Bus is backed by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3). When `CONDUIT_DB_PATH` is not set, it uses `:memory:` and data is lost on restart.

### SQLite schema

<!-- Full DDL for the three tables and indexes -->
```sql
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  started_at     INTEGER NOT NULL,   -- Unix ms
  client         TEXT,               -- optional label
  agent_name     TEXT,               -- optional label
  model_default  TEXT,
  ended_at       INTEGER             -- nullable, not yet populated
);

CREATE TABLE requests (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id),
  ts                    INTEGER NOT NULL,   -- Unix ms
  model                 TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL,
  output_tokens         INTEGER NOT NULL,
  cache_read_tokens     INTEGER DEFAULT 0,
  cache_write_tokens    INTEGER DEFAULT 0,
  latency_ms            INTEGER,
  cost_usd              REAL,
  baseline_cost_usd     REAL,
  optimizations_applied TEXT,   -- JSON array, e.g. '["cache_tools","cache_system"]'
  saved_tokens          INTEGER
);

CREATE TABLE cache_events (
  request_id       TEXT NOT NULL REFERENCES requests(id),
  breakpoint_index INTEGER NOT NULL,
  placed_at        TEXT NOT NULL,   -- "tools" | "system" | "messages"
  hit              INTEGER,         -- 0 or 1
  tokens_covered   INTEGER,
  PRIMARY KEY (request_id, breakpoint_index)
);

CREATE INDEX idx_requests_session ON requests(session_id);
CREATE INDEX idx_requests_ts      ON requests(ts);
```

### SessionReport fields

| Field | Description |
|---|---|
| `sessionId` | UUID of the session |
| `startedAt` | Session start time (Unix ms) |
| `requestCount` | Total requests recorded |
| `totalInputTokens` | Sum of `input_tokens` across all requests |
| `totalOutputTokens` | Sum of `output_tokens` |
| `totalCacheReadTokens` | Sum of `cache_read_tokens` — tokens served from cache |
| `totalSavedTokens` | Sum of `saved_tokens` as estimated by L4 |
| `totalCostUsd` | Sum of `cost_usd` (actual, if provided by caller) |
| `totalBaselineCostUsd` | Sum of `baseline_cost_usd` (what it would have cost without caching) |
| `avgCacheHitRate` | `totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)` |

---

## Layer numbering

| Layer | Status | Description |
|---|---|---|
| **L1** | ✅ Shipped | Lazy Tool Registry |
| **L2** | ✅ Shipped | Semantic Deduplicator |
| **L3** | ✅ Shipped | Context Compressor |
| **L4** | ✅ Shipped | Cache Orchestrator |
| **L5** | ✅ Shipped | Model Router + A/B Testing |
| **L6** | ✅ Shipped | Observability Bus |
| **L7** | ✅ Shipped | Agent Handoff Compressor |
| **L8** | ✅ Shipped | Feedback Loop |

---

## L2 — Semantic Deduplicator

> **Status:** Shipped ✦ Phase 2

`SemanticDeduplicator.deduplicateMessages()` processes each message block in two passes:

1. **Exact match** — SHA-256 hash (16-char prefix). If a block's hash was seen before, its content is replaced with `[duplicate of: <hash>]`.
2. **MinHash near-duplicate** — 128-hash MinHash signature over 3-word shingles. If Jaccard similarity ≥ `threshold` (default 0.97), content is replaced with `[near-duplicate (~N% similar) of: <hash>]`. Only applied to blocks longer than 100 characters.

Caches are reset per call — deduplication is stateless across requests.

---

## L3 — Context Compressor

> **Status:** Shipped ✦ Phase 2

`ContextCompressor.compress()` checks the estimated token count of the full messages array. If it exceeds `triggerTokens` (default 8 000) and the array is longer than `keepRecentTurns` (default 4):

1. Splits messages into `toCompress` (all but the last N turns) and `toKeep` (last N turns).
2. Calls `claude-haiku-4-5` with a strict compression system prompt to produce a bullet-point summary.
3. Returns `[summaryBlock, ...toKeep]`.

Falls back to a heuristic 150-char line-preview per message when no `ANTHROPIC_API_KEY` is available.

---

## L5 — Model Router + A/B Testing

> **Status:** Shipped ✦ Phase 4

**ModelRouter** (`l5-router.ts`) classifies a prompt by scanning for keyword lists and length heuristics:

- Opus keywords: `architect`, `security audit`, `multi-file`, `refactor entire`, etc.
- Haiku keywords (aggressive policy only): `format`, `summarize`, `list`, `translate`, etc.
- Short prompt heuristic (< 200 chars) → Haiku under `aggressive`.
- Long prompt with code (> 4 000 chars + `` ``` `` or `function`) → Opus.

**ABTesting** (`l5-ab-testing.ts`) stores experiments and assignments in the L6 SQLite database. Assignment is random on first call and sticky thereafter (same `session_id` always gets the same variant).

---

## L7 — Agent Handoff Compressor

> **Status:** Shipped ✦ Phase 3

`AgentHandoffCompressor.compress()` calls `claude-haiku-4-5` with a structured extraction prompt to produce a `HandoffContract` JSON object containing: `task`, `relevant_context`, `expected_output`, `constraints`, `prior_decisions`, and `open_questions`.

It also builds a formatted Markdown `system_prompt` the receiving agent can load directly. Contracts are stored in an in-process `Map` keyed by UUID and retrieved via `fetch(id)`.

Falls back to a heuristic 200-char preview of the last 6 messages when no API key is present.

---

## L8 — Feedback Loop

> **Status:** Shipped ✦ Phase 3

`FeedbackLoop` writes feedback records to the L6 SQLite database (tables `feedback` and `rule_stats`). On every `recordFeedback` call it upserts the rule's win/bad/partial counters. After each upsert it checks: if `evaluations >= 5` and `bad_rate > 40%`, the rule is automatically set to `enabled = 0` with an `auto_disabled_at` timestamp.

`formatRuleReport()` returns a Markdown table consumed directly by `conduit_feedback` and `conduit_optimization_stats`.

---

*← [Tools Reference](TOOLS.md) · [Back to README](../README.md) · [Next → Benchmarks](BENCHMARKS.md)*
