# Architecture

claude-conduit is a thin MCP server process that wraps the Anthropic Messages API. It does not proxy network traffic — instead, it prepares requests that your agent then sends to Anthropic directly. Three layers ship in Phase 1.

---

## System overview

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Client (Claude Code, agent, script)                    │
└────────────────────────┬────────────────────────────────────┘
                         │  MCP tool calls (stdio)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  claude-conduit (MCP server)                                │
│                                                             │
│  ┌─────────────────┐  ┌───────────────────┐  ┌──────────┐  │
│  │  L1              │  │  L4               │  │  L6      │  │
│  │  Lazy Tool       │  │  Cache            │  │  Observ- │  │
│  │  Registry        │  │  Orchestrator     │  │  ability │  │
│  │                  │  │                   │  │  Bus     │  │
│  │  search, describe│  │  wrapRequest()    │  │  SQLite  │  │
│  │  execute         │  │  cache_control    │  │  reports │  │
│  └─────────────────┘  └───────────────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
                         │  optimized request returned to client
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Client sends request to Anthropic API                      │
└─────────────────────────────────────────────────────────────┘
```

conduit does **not** sit in the HTTP path. It transforms request objects in memory and returns them. The client is responsible for the actual API call.

---

## Request flow

A typical optimized request follows this path:

```
1. Agent builds Anthropic request (model, system, messages, tools)

2. Agent calls conduit_wrap_request(request)
   └── L4 CacheOrchestrator.wrapRequest()
       ├── Deep-clone the request (no mutation of original)
       ├── If tools present → inject cache_control on last tool      [breakpoint 1]
       ├── If system >= 1024 tokens → inject cache_control on system [breakpoint 2]
       ├── If messages.length >= 4 → inject cache_control on last
       │   user message content block                                [breakpoint 3]
       ├── Estimate token counts (before / after)
       └── Return { request: optimized, meta: CacheMeta }

3. Agent sends optimized request to Anthropic API

4. Anthropic responds with usage.cache_read_input_tokens etc.

5. Agent calls obs.recordRequest(record) with actual token counts
   └── L6 ObservabilityBus writes to SQLite

6. Agent calls conduit_report / conduit_explain to inspect session
   └── L6 reads aggregated stats from SQLite
```

---

## L1 — Lazy Tool Registry

The Lazy Tool Registry stores tool definitions in a `Map<string, ToolDefinition>` keyed by name. Tools are **not** serialized and sent to the model at startup — the agent fetches only what it needs, on demand.

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

`CacheOrchestrator.wrapRequest()` follows Anthropic's prompt caching rules and injects breakpoints in the order that maximises reuse across turns.

### cache_control placement order

Anthropic evaluates cache breakpoints from the top of the context downward. Placing breakpoints where content is **stable across calls** gives the highest hit rate.

```
Request structure:          Stability          Action
─────────────────────────────────────────────────────────
tools[]                     High (rarely changes)  → breakpoint on last tool
system                      High (rarely changes)  → breakpoint on system block
messages (history)          Medium (grows each turn) → breakpoint on last user msg
```

Placing tools first ensures the schema block is cached even when the system prompt is short. Placing messages last avoids re-caching the entire history on every turn.

### Minimum sizes

| Optimization | Condition |
|---|---|
| `cache_tools` | `tools` array must be non-empty |
| `cache_system` | System prompt must be >= 1 024 tokens (Anthropic minimum) |
| `cache_messages` | Conversation must have >= 4 messages |

### Token estimation

conduit uses the heuristic `ceil(text.length / 4)` for token estimation. This is a fast approximation — actual Anthropic token counts will differ slightly. The `saved_tokens` and `saved_usd_estimated` fields in `CacheMeta` are estimates only.

### Pricing table (used for saved_usd_estimated)

| Model | Input (per 1M tokens) |
|---|---|
| claude-opus-4-7 | $15.00 |
| claude-sonnet-4-6 | $3.00 |
| claude-haiku-4-5 | $0.80 |
| (unknown model) | $3.00 |

---

## L6 — Observability Bus

The Observability Bus is backed by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3). When `CONDUIT_DB_PATH` is not set, it uses `:memory:` and data is lost on restart.

### SQLite schema

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

The layers are numbered with gaps intentionally — Phase 1 ships L1, L4, and L6. The gaps are reserved:

| Layer | Status | Description |
|---|---|---|
| L1 | Shipped | Lazy Tool Registry |
| L2 | Phase 2 | Semantic deduplication |
| L3 | Phase 2 | Context compression |
| L4 | Shipped | Cache Orchestrator |
| L5 | Phase 2 | Model router |
| L6 | Shipped | Observability Bus |

---

## Phase 2 — Coming next

**L2 Semantic Deduplication**
Detects near-duplicate content blocks across the messages array using embedding similarity. Duplicate assistant turns, repeated tool results, and re-stated context can be collapsed or pointer-replaced before sending to the API.

**L3 Context Compression**
For very long conversations, L3 will apply a compression step: summarise older message turns into a compact representation, keeping only the most recent N turns verbatim. This is complementary to prompt caching — it reduces the total token budget before breakpoints are placed.

Both L2 and L3 will expose their own `conduit_*` MCP tools and integrate into the same `wrapRequest` pipeline. The `disable` array on `conduit_wrap_request` will support `"deduplicate"` and `"compress"` flags for opt-out.
