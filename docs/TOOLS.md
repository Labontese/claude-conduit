# Tools Reference

> All MCP tools exposed by claude-conduit — inputs, outputs, and worked examples.

Tools are grouped by the task they accomplish, not by internal layer.
Each canonical tool is documented here; deprecated aliases from 0.3.x
forward to the same handler and are listed in the
[Migration guide](../README.md#migration-from-03x).

---

## Overview

| Group | Tools |
|---|---|
| [Optimise one API call](#optimise-one-api-call) | `conduit_optimize_request`, `conduit_route_model` |
| [Shrink conversation history](#shrink-conversation-history) | `conduit_dedupe`, `conduit_summarize_history` |
| [Hand off to the next agent](#hand-off-to-the-next-agent) | `conduit_handoff_pack`, `conduit_handoff_load` |
| [Measure and explain](#measure-and-explain) | `conduit_cost_report`, `conduit_explain_request`, `conduit_optimization_stats`, `conduit_feedback` |
| [Experiment (A/B)](#experiment-ab) | `conduit_ab_create`, `conduit_ab_get_variant`, `conduit_ab_list` |
| [Advanced / infrastructure](#advanced--infrastructure) | `conduit_search_tools`, `conduit_describe_tool`, `conduit_call_tool` |

---

## Optimise one API call

### `conduit_optimize_request`

The primary optimisation tool. Injects `cache_control: { type: "ephemeral" }`
breakpoints at up to three positions (last tool, system block, last user
message) and returns the modified request alongside a `CacheMeta` object
describing what was done.

Accepts either the full Anthropic Messages request object or a minimal
`{model, messages}` pair.

#### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `request` | `AnthropicRequest` | one of `request` or (`model` + `messages`) | Full Anthropic Messages API request |
| `model` | `string` | minimal form | Model ID — used together with `messages` |
| `messages` | `Array<{role, content}>` | minimal form | Messages — used together with `model` |
| `session_id` | `string` | no | Session ID for observability correlation |
| `agent_name` | `string` | no | Agent label for session tagging |
| `disable` | `string[]` | no | Optimisations to skip: `"cache_tools"`, `"cache_system"`, `"cache_messages"` |

**AnthropicRequest shape:**

```typescript
{
  model: string;                    // e.g. "claude-sonnet-4-6"
  max_tokens?: number;
  system?: string | Array<{
    type: string;
    text: string;
    cache_control?: { type: string };
  }>;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  }>;
  tools?: Array<Record<string, unknown>>;
  [key: string]: unknown;           // other Anthropic fields pass through unchanged
}
```

#### Output

```typescript
{
  request: AnthropicRequest;  // optimised request, ready to send to Anthropic
  meta: {
    input_tokens_before: number;
    input_tokens_after: number;
    saved_tokens: number;
    saved_usd_estimated: number;
    optimizations_applied: string[];   // which of the three optimisations fired
    cache_breakpoints: number;         // 0-3
    notes: string[];                   // human-readable notes on skipped optimisations
  }
}
```

#### Optimisation logic

| Optimisation | Condition | Action |
|---|---|---|
| `cache_tools` | `tools` array is present and non-empty | Adds `cache_control` to the last tool |
| `cache_system` | `system` is present AND >= 1024 tokens | Converts string to block array with `cache_control`, or tags last block if already an array |
| `cache_messages` | `messages` has 4 or more entries | Adds `cache_control` to the last content block of the last user message |

#### Example — minimal form

```typescript
const wrapped = await mcp.call("conduit_optimize_request", {
  model: "claude-sonnet-4-6",
  messages: [
    { role: "user",      content: "Review this code." },
    { role: "assistant", content: "Sure, paste it." },
    { role: "user",      content: "```ts\n// ...\n```" },
    { role: "user",      content: "What are the issues?" }
  ]
});
// wrapped.request → ready to send to Anthropic
// wrapped.meta    → token and cost savings
```

#### Example — full form with one optimisation disabled

```typescript
const wrapped = await mcp.call("conduit_optimize_request", {
  request: {
    model: "claude-opus-4-7",
    system: "You are a senior software engineer...", // >= 1024 tokens
    messages: [
      { role: "user",      content: "Review this code." },
      { role: "assistant", content: "Sure, paste it." },
      { role: "user",      content: "```ts\n// ...\n```" },
      { role: "user",      content: "What are the issues?" }
    ],
    tools: [{ name: "search_codebase", description: "...", input_schema: {} }]
  },
  disable: ["cache_messages"]
});
// wrapped.meta.optimizations_applied → ["cache_tools", "cache_system"]
// wrapped.meta.cache_breakpoints     → 2
```

#### Pricing reference (used for `saved_usd_estimated`)

| Model | Input price per 1M tokens |
|---|---|
| `claude-opus-4-7` | $15.00 |
| `claude-sonnet-4-6` | $3.00 |
| `claude-haiku-4-5` | $0.80 |
| (other / unknown) | $3.00 (default) |

---

### `conduit_route_model`

Suggest the cheapest capable model for a given prompt. Heuristic only —
no API call. Returns a model recommendation with tier, confidence, and
reasoning.

#### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | `string` | yes | — | Prompt or task description to route |
| `policy` | `"aggressive"` \| `"conservative"` \| `"off"` | no | `"conservative"` | Routing aggressiveness |
| `force_model` | `string` | no | — | Override: return this exact model ID |

#### Routing logic

| Policy | Opus triggers | Haiku triggers | Default |
|---|---|---|---|
| `conservative` | Task keywords (architect, security audit, ...) | — | Sonnet |
| `aggressive` | Task keywords + long code prompts (> 4000 chars) | Simple task keywords (format, summarise, ...) + short prompts (< 200 chars) | Sonnet |
| `off` | — | — | Sonnet always |

#### Output

```typescript
{
  model: string;             // full model ID, e.g. "claude-haiku-4-5-20251001"
  tier: "haiku" | "sonnet" | "opus";
  confidence: number;        // 0-1
  reason: string;            // human-readable explanation
  cost_per_1m_input: number; // USD per 1M input tokens
}
```

#### Example

```typescript
const decision = await mcp.call("conduit_route_model", {
  prompt: "Summarise the following list of errors into bullet points",
  policy: "aggressive"
});
// decision.model  → "claude-haiku-4-5-20251001"
// decision.tier   → "haiku"
// decision.reason → 'simple task keyword: "summarise"'

const override = await mcp.call("conduit_route_model", {
  prompt: "...",
  force_model: "claude-opus-4-7"
});
// override.reason → "force_model override"
```

---

## Shrink conversation history

### `conduit_dedupe`

Remove duplicate or near-duplicate items from a list. Uses SHA-256 exact
matching and MinHash Jaccard similarity for near-duplicates. Accepts
strings or `{role, content}` objects. Case-insensitive by default;
returns a clean list by default.

#### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `items` | `string[]` \| `Array<{role, content}>` | yes (or `messages`) | — | Items to deduplicate. Strings are wrapped as `role: "user"`. |
| `messages` | `Array<{role, content}>` | legacy alias for `items` | — | Still accepted for backwards compatibility |
| `threshold` | `number` (0-1) | no | `0.97` | Similarity threshold. Lower = more aggressive. |
| `case_sensitive` | `boolean` | no | `false` | When `false`, hashes `.toLowerCase().trim()` so `"Hello"` and `"HELLO"` merge |
| `return` | `"clean"` \| `"annotated"` | no | `"clean"` | `"clean"` removes duplicates; `"annotated"` keeps them with `[duplicate of: hash]` markers |

#### Output

```typescript
{
  items: Array<{ role: "user" | "assistant"; content: string }>;
  stats: {
    blocks_total: number;
    blocks_deduplicated: number;
    tokens_saved_estimate: number;
    strategy_used: "exact" | "minhash" | "mixed" | "none";
  }
}
```

#### Example — plain strings

```typescript
const result = await mcp.call("conduit_dedupe", {
  items: [
    "Here is the file content: ...",
    "Now summarise it.",
    "HERE IS THE FILE CONTENT: ...",   // case-insensitive duplicate
    "What are the issues?"
  ]
});
// result.items.length              → 3
// result.stats.blocks_deduplicated → 1
```

#### Example — message objects with annotated output

```typescript
const result = await mcp.call("conduit_dedupe", {
  items: [
    { role: "user",      content: "Read the file." },
    { role: "assistant", content: "Here is the content: ..." },
    { role: "user",      content: "Now summarise." },
    { role: "assistant", content: "Here is the content: ..." }
  ],
  return: "annotated"
});
// result.items[3].content → "[duplicate of: <hash>]"
```

> **Tip:** Run `conduit_dedupe` before `conduit_optimize_request` to reduce
> the message array before cache breakpoints are placed.

---

### `conduit_summarize_history`

Summarise a long conversation by compressing older turns into a compact
memory block, while keeping the most recent turns verbatim. Summarisation
uses `claude-haiku-4-5`. Falls back to a heuristic line-preview if no API
key is present.

#### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `items` | `string[]` \| `Array<{role, content}>` | yes (or `messages`) | — | Conversation to compress. Strings wrapped as `role: "user"`. |
| `messages` | `Array<{role, content}>` | legacy alias for `items` | — | Still accepted |
| `preset` | `"aggressive"` \| `"balanced"` \| `"light"` | no | `"balanced"` | Named profile for the two thresholds below |
| `trigger_tokens` | `number` | no | preset-dependent | Explicit token threshold — overrides preset |
| `keep_recent_turns` | `number` | no | preset-dependent | Explicit recent-turn count — overrides preset |

#### Output

```typescript
{
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  compressed: boolean;   // false if under the threshold — messages unchanged
  stats: {
    turns_before: number;
    turns_after: number;
    tokens_before_estimate: number;
    tokens_after_estimate: number;
    compression_ratio: number;   // < 1 means tokens were saved
  }
}
```

The compressed history is prepended as a single `user` message:

```
[Compressed conversation history]
- Decided to use SQLite for session storage
- File paths: src/l6-observability.ts, src/index.ts
- Open question: should cache_system fire for prompts < 512 tokens?
```

#### Example — preset-based

```typescript
const result = await mcp.call("conduit_summarize_history", {
  items: longHistory,       // 40+ turns, strings or {role, content}[]
  preset: "balanced"
});
// result.compressed              → true
// result.stats.compression_ratio → 0.18  (82% reduction)
// result.messages                → [summaryBlock, ...recentTurns]
```

> **Note:** Full semantic compression requires `ANTHROPIC_API_KEY`. Without
> it, a heuristic line-preview fallback is used — no API call, lower
> summary quality.

---

## Hand off to the next agent

### `conduit_handoff_pack`

Compress the current conversation into a structured **HandoffContract** for
the next agent. Uses `claude-haiku-4-5` to extract task, context,
constraints, decisions, and open questions. Also returns a ready-to-use
system prompt the receiving agent can load directly.

`from_agent` and `to_agent` are optional metadata — only `task` and
`messages` are required.

#### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | `string` | yes | One sentence describing what the receiving agent must do |
| `messages` | `string[]` \| `Array<{role, content}>` | yes | Conversation history to compress |
| `from_agent` | `string` | no | Name of the current (sending) agent |
| `to_agent` | `string` | no | Name of the receiving agent |
| `context_hint` | `string` | no | Extra context note forwarded to the compressor |

#### Output

```typescript
{
  contract: {
    id: string;              // UUID — use with conduit_handoff_load
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
  };
  system_prompt: string;     // ready-to-use system prompt for the receiving agent
}
```

#### Example

```typescript
const handoff = await mcp.call("conduit_handoff_pack", {
  task:     "Implement the SQLite schema described in the planning session",
  messages: planningHistory,
  from_agent: "PlannerAgent",        // optional metadata
  to_agent:   "CoderAgent",          // optional metadata
  context_hint: "Focus on the requests and cache_events tables"
});

// handoff.contract.id     → "3f2a1b0c-..."  (store for later lookup)
// handoff.system_prompt   → "## Handoff from PlannerAgent\n\n**Task:** ..."
```

> **Tip:** Inject `handoff.system_prompt` as the system prompt of the
> receiving agent's first request. Use `conduit_handoff_load` later to
> retrieve the full structured contract by ID.

---

### `conduit_handoff_load`

Retrieve a previously created HandoffContract by its ID. Contracts are
stored in memory for the lifetime of the conduit process.

#### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `handoff_id` | `string` | yes | UUID returned by `conduit_handoff_pack` |

#### Output

On success — the full `HandoffContract` object (same shape as `contract`
in `conduit_handoff_pack` output).

On failure — error with `isError: true`:

```json
"Handoff not found: 3f2a1b0c-..."
```

#### Example

```typescript
const contract = await mcp.call("conduit_handoff_load", {
  handoff_id: "3f2a1b0c-..."
});
// contract.prior_decisions → ["Use snake_case for all column names", ...]
```

> **Note:** Contracts live in the conduit process's memory. They are lost
> on server restart. If persistence is needed, serialise `contract` to
> your own store immediately after `conduit_handoff_pack`.

---

## Measure and explain

### `conduit_cost_report`

Returns a token usage and cost report for a session.

#### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `session_id` | `string` | no | current session | Session UUID to report on |
| `format` | `"json"` \| `"markdown"` | no | `"markdown"` | Output format |

#### Output — Markdown (default)

```
## conduit_cost_report — session a3f2c1b0

| Metric            | Value   |
|-------------------|---------|
| Requests          | 12      |
| Input tokens      | 28,400  |
| Cache read tokens | 21,200  |
| Cache hit rate    | 74.7%   |
| Tokens saved      | 19,600  |
| Est. cost         | $0.0213 |
| Baseline cost     | $0.0852 |
| Savings           | 75.0%   |
```

#### Output — JSON

```json
{
  "sessionId": "a3f2c1b0-...",
  "startedAt": 1713693600000,
  "requestCount": 12,
  "totalInputTokens": 28400,
  "totalOutputTokens": 6200,
  "totalCacheReadTokens": 21200,
  "totalSavedTokens": 19600,
  "totalCostUsd": 0.0213,
  "totalBaselineCostUsd": 0.0852,
  "avgCacheHitRate": 0.747
}
```

#### Example

```typescript
const report = await mcp.call("conduit_cost_report", {});          // markdown
const data   = await mcp.call("conduit_cost_report", { format: "json" });
```

> **Note:** Reads from the SQLite database. Set `CONDUIT_DB_PATH` for
> persistent reporting across server restarts.

---

### `conduit_explain_request`

Returns a one-paragraph, human-readable summary of what conduit optimised
this session. Useful for logging, agent reasoning, or quick sanity checks.

#### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `request_id` | `string` | no | Reserved for future per-request explanations |

#### Output

Plain text:

```
conduit has processed 12 request(s) this session.
Cache hit rate: 74.7%
Estimated token reduction: 75.0%
Estimated cost saved: $0.0639
```

#### Example

```typescript
const summary = await mcp.call("conduit_explain_request", {});
console.log(summary);
```

---

### `conduit_optimization_stats`

Return a summary table of all optimisation rules tracked by the feedback
loop, including evaluation counts, win/bad rates, and whether each rule
has been auto-disabled.

#### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `format` | `"json"` \| `"markdown"` | no | `"markdown"` | Output format |

#### Output — Markdown (default)

```
## Rule Stats

| Rule | Evals | Good | Bad | Partial | Win Rate | Status |
|---|---|---|---|---|---|---|
| `cache_tools`  | 12 | 11 | 1 | 0 | 92% | Active |
| `cache_system` |  8 |  6 | 2 | 0 | 75% | Active |
```

#### Output — JSON

```json
[
  {
    "rule_name": "cache_tools",
    "evaluations": 12,
    "wins_good": 11,
    "wins_bad": 1,
    "wins_partial": 0,
    "enabled": 1,
    "auto_disabled_at": null,
    "win_rate": 0.917
  }
]
```

#### Example

```typescript
const stats = await mcp.call("conduit_optimization_stats", {});
const data  = await mcp.call("conduit_optimization_stats", { format: "json" });
```

---

### `conduit_feedback`

Record quality feedback on a request. Feedback is written to SQLite and
used to track which optimisation rules are helping or hurting. Rules with
a bad rate above 40% (over at least 5 evaluations) are automatically
disabled.

#### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `request_id` | `string` | yes | The request ID to rate |
| `rating` | `"good"` \| `"bad"` \| `"partial"` | yes | Quality outcome |
| `rule_suspected` | `string` | no | Optimisation rule you suspect caused a problem (e.g. `"cache_system"`) |
| `notes` | `string` | no | Free-text notes |

#### Output

Returns the current rule stats report (same shape as
`conduit_optimization_stats` with `format: "markdown"`).

#### Example

```typescript
await mcp.call("conduit_feedback", {
  request_id:     "req_abc123",
  rating:         "bad",
  rule_suspected: "cache_messages",
  notes:          "Model ignored cached history and repeated earlier reasoning"
});
```

---

## Experiment (A/B)

### `conduit_ab_create`

Create a named A/B experiment with two or more instruction variants.
Experiments are persisted in SQLite and survive conduit restarts when
`CONDUIT_DB_PATH` is set.

#### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Unique experiment name |
| `variants` | `Array<{name, instruction}>` | yes | At least 2 variants |

#### Output

```typescript
{
  id: string;         // UUID
  name: string;
  variants: Array<{ name: string; instruction: string }>;
  created_at: number;
  active: number;     // 1 = active
}
```

#### Example

```typescript
const exp = await mcp.call("conduit_ab_create", {
  name: "cache-tone-test",
  variants: [
    { name: "control",   instruction: "Be concise." },
    { name: "treatment", instruction: "Be concise. Think step by step before answering." }
  ]
});
// exp.id → "7e3f1a2c-..."
```

---

### `conduit_ab_get_variant`

Get the assigned instruction variant for a session in an active
experiment. Assignments are deterministic — the same `session_id` always
gets the same variant.

#### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session_id` | `string` | yes | Current session identifier |
| `experiment_name` | `string` | yes | Name of an active experiment |

#### Output

On success:

```typescript
{
  experiment_id: string;
  variant_name: string;
  instruction: string;   // inject into the agent's system prompt or first user message
}
```

On failure (experiment not found or inactive) — error with `isError: true`.

#### Example

```typescript
const assignment = await mcp.call("conduit_ab_get_variant", {
  session_id:       "sess_xyz",
  experiment_name:  "cache-tone-test"
});
// assignment.variant_name → "treatment"
// assignment.instruction  → "Be concise. Think step by step before answering."
```

> **Tip:** Combine with `conduit_feedback` to close the loop — assign a
> variant at session start, record feedback at the end, then use
> `conduit_optimization_stats` to compare variants.

---

### `conduit_ab_list`

List all A/B experiments, including inactive ones. Sorted newest-first.

#### Input

No parameters.

#### Output

Array of `ABExperiment` objects (same shape as `conduit_ab_create` output).

#### Example

```typescript
const experiments = await mcp.call("conduit_ab_list", {});
// [{ id: "...", name: "cache-tone-test", active: 1, variants: [...] }, ...]
```

---

## Advanced / infrastructure

These are the L1 lazy-tool-registry tools. Most agents never need to call
them directly — conduit registers application tools through this registry
so schemas are only loaded when a tool is actually used.

### `conduit_search_tools`

Search registered tools by keyword. Returns **names and descriptions only** —
schemas are not loaded, so this call is token-free.

#### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | `string` | yes | — | Keyword or phrase to match against names and descriptions |
| `max_results` | `number` | no | `5` | Maximum number of results |

#### Output

JSON array of `{ name, description }` objects, sorted by relevance.

```json
[
  { "name": "list_files", "description": "List files in a directory" },
  { "name": "read_file",  "description": "Read the contents of a file" }
]
```

#### Example

```typescript
const result = await mcp.call("conduit_search_tools", {
  query: "file",
  max_results: 3
});
```

---

### `conduit_describe_tool`

Returns the full JSON schema for a single registered tool.

#### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Exact tool name as returned by `conduit_search_tools` |

#### Output — success

```json
{
  "name": "list_files",
  "description": "List files in a directory",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string" },
      "recursive": { "type": "boolean" }
    },
    "required": ["path"]
  }
}
```

#### Output — not found

Error with `isError: true`: `"Tool not found: list_files"`

#### Example

```typescript
const schema = await mcp.call("conduit_describe_tool", { name: "list_files" });
```

---

### `conduit_call_tool`

Execute a registered tool by name, passing arguments as a key/value record.
Named after the MCP convention (`tools/call`). The deprecated alias
`conduit_execute_tool` forwards to the same handler.

#### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Tool name |
| `args` | `Record<string, unknown>` | no | Arguments matching the tool's `inputSchema` |

#### Output

On success — the tool's return value, JSON-serialised.

```json
{
  "files": ["index.ts", "l1-tool-registry.ts", "l4-cache-orchestrator.ts"]
}
```

On failure — error string with `isError: true`.

#### Example

```typescript
const result = await mcp.call("conduit_call_tool", {
  name: "list_files",
  args: { path: "./src", recursive: false }
});
```

> **Note:** If `args` is omitted, conduit passes an empty object `{}` to
> the tool handler.

---

*← [Getting Started](GETTING-STARTED.md) · [Back to README](../README.md) · [Next → Architecture](ARCHITECTURE.md)*
