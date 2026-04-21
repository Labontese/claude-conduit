# Tools Reference

> All MCP tools exposed by claude-conduit — inputs, outputs, and worked examples for each.

---

## Overview

| Tool | Purpose | When to use |
|---|---|---|
| `conduit_search_tools` | 🔍 Find tools by intent | Before calling a tool you are unsure of |
| `conduit_describe_tool` | 📋 Get full schema for one tool | Before executing an unfamiliar tool |
| `conduit_execute_tool` | ▶️ Run a registered tool | When you know the exact tool name and args |
| `conduit_wrap_request` | 🔧 Inject cache breakpoints | Every Anthropic API call in a long-running agent |
| `conduit_report` | 📊 Session token/cost report | After a batch of requests, or on a schedule |
| `conduit_explain` | 💬 Human-readable session summary | Quick status check, end-of-session logging |
| `conduit_deduplicate` | 🧹 Remove duplicate messages | Before sending long conversations with repeated content |
| `conduit_compress` | 🗜️ Summarize old conversation turns | When context exceeds your token budget |
| `conduit_handoff` | 🤝 Create agent handoff contract | When handing off work between agents |
| `conduit_fetch_handoff` | 📥 Retrieve a handoff contract | On agent startup, when receiving a handoff |
| `conduit_feedback` | ⭐ Rate a request's quality | After observing a good or bad optimization outcome |
| `conduit_rule_stats` | 📈 View optimization rule health | Regularly, to track which rules help or hurt |
| `conduit_route_model` | 🧭 Pick cheapest capable model | Before every Anthropic API call to minimize cost |
| `conduit_ab_create` | 🧪 Create an A/B experiment | When testing two instruction variants |
| `conduit_ab_assign` | 🎲 Assign a session to a variant | At the start of a session in an active experiment |
| `conduit_ab_list` | 📋 List all experiments | To inspect active and past experiments |

---

## conduit_search_tools

Search registered tools by keyword or intent. Returns **names and descriptions only** — schemas are not loaded, so this call is token-free.

### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | `string` | yes | — | Keyword or phrase to match against tool names and descriptions |
| `max_results` | `number` | no | `5` | Maximum number of results to return |

### Output

JSON array of `{ name: string, description: string }` objects, sorted by relevance score (name match > description match).

<!-- conduit_search_tools — example response -->
```json
[
  {
    "name": "list_files",
    "description": "List files in a directory"
  },
  {
    "name": "read_file",
    "description": "Read the contents of a file"
  }
]
```

### Example call

<!-- Search for file-related tools without loading any schemas -->
```typescript
const result = await mcp.call("conduit_search_tools", {
  query: "file",
  max_results: 3
});
```

> 💡 **Tip:** Use `conduit_search_tools` at the start of a reasoning step to discover relevant tools without paying for schema tokens. Only fetch the schema with `conduit_describe_tool` when you are ready to call the tool.

---

## conduit_describe_tool

Returns the full JSON schema for a single registered tool, including its `inputSchema`.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Exact tool name as returned by `conduit_search_tools` |

### Output

On success — JSON object with `name`, `description`, and `inputSchema`:

<!-- conduit_describe_tool — success response -->
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

On failure — error response with `isError: true`:

```json
"Tool not found: list_files"
```

### Example call

<!-- Fetch full schema before executing a tool -->
```typescript
const schema = await mcp.call("conduit_describe_tool", { name: "list_files" });
```

---

## conduit_execute_tool

Execute a registered tool by name, passing arguments as a key/value record.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Tool name |
| `args` | `Record<string, unknown>` | no | Arguments matching the tool's `inputSchema` |

### Output

On success — the tool's return value, JSON-serialized:

```json
{
  "files": ["index.ts", "l1-tool-registry.ts", "l4-cache-orchestrator.ts"]
}
```

On failure — error string with `isError: true`:

```json
"Error: Tool not found: nonexistent_tool"
```

### Example call

<!-- Execute a tool with explicit args -->
```typescript
const result = await mcp.call("conduit_execute_tool", {
  name: "list_files",
  args: { path: "./src", recursive: false }
});
```

> ⚠️ **Note:** If `args` is omitted, conduit passes an empty object `{}` to the tool handler.

---

## conduit_wrap_request

The primary optimization tool. Accepts a full Anthropic Messages API request object and injects `cache_control: { type: "ephemeral" }` breakpoints at up to three positions. Returns the modified request alongside a `CacheMeta` object describing what was done.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `request` | `AnthropicRequest` | yes | Full Anthropic Messages API request (see schema below) |
| `session_id` | `string` | no | Session ID for observability correlation |
| `agent_name` | `string` | no | Agent label for session tagging |
| `disable` | `string[]` | no | Optimizations to skip: `"cache_tools"`, `"cache_system"`, `"cache_messages"` |

**AnthropicRequest shape:**

<!-- TypeScript type for the request parameter -->
```typescript
{
  model: string;                    // e.g. "claude-sonnet-4-6"
  max_tokens?: number;
  system?: string | Array<{         // string or block array
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

### Output

<!-- CacheMeta shape returned alongside the optimized request -->
```typescript
{
  request: AnthropicRequest;  // optimized request, ready to send to Anthropic
  meta: {
    input_tokens_before: number;       // estimated token count before optimization
    input_tokens_after: number;        // estimated token count after optimization
    saved_tokens: number;              // difference (may be 0)
    saved_usd_estimated: number;       // estimated USD savings at model's input price
    optimizations_applied: string[];   // which of the three optimizations fired
    cache_breakpoints: number;         // total breakpoints injected (0–3)
    notes: string[];                   // human-readable notes on skipped optimizations
  }
}
```

### Optimization logic

| Optimization | Condition | Action |
|---|---|---|
| `cache_tools` | `tools` array is present and non-empty | Adds `cache_control` to the last tool in the array |
| `cache_system` | `system` is present AND >= 1024 tokens | Converts string to block array with `cache_control`, or tags last block if already an array |
| `cache_messages` | `messages` has 4 or more entries | Adds `cache_control` to the last content block of the last user message |

### Example call

<!-- Wrap a full request, selectively disabling one optimization -->
```typescript
const wrapped = await mcp.call("conduit_wrap_request", {
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
  disable: ["cache_messages"]  // skip message caching for this call
});

// wrapped.meta.optimizations_applied → ["cache_tools", "cache_system"]
// wrapped.meta.cache_breakpoints     → 2
```

### Pricing reference (used for `saved_usd_estimated`)

| Model | Input price per 1M tokens |
|---|---|
| `claude-opus-4-7` | $15.00 |
| `claude-sonnet-4-6` | $3.00 |
| `claude-haiku-4-5` | $0.80 |
| (other / unknown) | $3.00 (default) |

---

## conduit_report

Returns a token usage and cost report for a session.

### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `session_id` | `string` | no | current session | Session UUID to report on |
| `format` | `"json"` \| `"markdown"` | no | `"markdown"` | Output format |

### Output

**Markdown format** (default) — a formatted table:

```
## conduit_report — session a3f2c1b0

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

**JSON format** — a `SessionReport` object:

<!-- conduit_report — JSON format response -->
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

### Example call

<!-- Request a report in both formats -->
```typescript
// Markdown (default)
const report = await mcp.call("conduit_report", {});

// JSON for programmatic use
const data = await mcp.call("conduit_report", { format: "json" });
```

> ⚠️ **Note:** `conduit_report` reads from the SQLite database. If conduit is running with the default in-memory store (no `CONDUIT_DB_PATH`), data is lost when the server restarts. Set `CONDUIT_DB_PATH` for persistent reporting.

---

## conduit_explain

Returns a one-paragraph, human-readable summary of what conduit optimized this session. Useful for logging, agent reasoning, or quick sanity checks.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `request_id` | `string` | no | Reserved for future per-request explanations (currently unused) |

### Output

Plain text string:

```
conduit has processed 12 request(s) this session.
Cache hit rate: 74.7%
Estimated token reduction: 75.0%
Estimated cost saved: $0.0639
```

### Example call

<!-- Plain-text session summary for logging or agent output -->
```typescript
const summary = await mcp.call("conduit_explain", {});
console.log(summary);
```

---

---

## conduit_deduplicate

Remove duplicate or near-duplicate messages from a conversation before sending to the API. Uses SHA-256 exact matching and MinHash Jaccard similarity for near-duplicates.

### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `messages` | `Array<{role, content}>` | yes | — | Conversation messages to deduplicate |
| `threshold` | `number` (0–1) | no | `0.97` | Similarity threshold for near-duplicate detection. Lower values are more aggressive. |

### Output

```typescript
{
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  stats: {
    blocks_total: number;           // total message blocks processed
    blocks_deduplicated: number;    // blocks replaced with duplicate references
    tokens_saved_estimate: number;  // estimated tokens saved
    strategy_used: "exact" | "minhash" | "none";
  }
}
```

Deduplicated blocks have their content replaced with a pointer string:

- Exact match: `[duplicate of: <hash>]`
- Near-duplicate: `[near-duplicate (~94% similar) of: <hash>]`

### Example call

<!-- Deduplicate a conversation with a repeated tool result -->
```typescript
const result = await mcp.call("conduit_deduplicate", {
  messages: [
    { role: "user",      content: "Read the file." },
    { role: "assistant", content: "Here is the content: ..." },
    { role: "user",      content: "Now summarize." },
    { role: "assistant", content: "Here is the content: ..." },  // near-duplicate
  ],
  threshold: 0.97
});
// result.stats.blocks_deduplicated → 1
// result.stats.strategy_used       → "exact"
```

> 💡 **Tip:** Run `conduit_deduplicate` before `conduit_wrap_request` to reduce the message array before breakpoints are placed. Deduplication works on the raw `content` string, so call it before any cache_control injection.

---

## conduit_compress

Compress a long conversation by summarizing older turns into a compact memory block, while keeping the most recent turns verbatim. Summarization uses `claude-haiku-4-5` via the Anthropic API. Falls back to a heuristic line-preview if no API key is present.

### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `messages` | `Array<{role, content}>` | yes | — | Full conversation history |
| `trigger_tokens` | `number` | no | `8000` | Token estimate threshold that must be exceeded before compression fires |
| `keep_recent_turns` | `number` | no | `4` | Number of most-recent turns to keep verbatim |

### Output

```typescript
{
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  compressed: boolean;  // false if under the threshold — messages unchanged
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
• Decided to use SQLite for session storage
• File paths: src/l6-observability.ts, src/index.ts
• Open question: should cache_system fire for prompts < 512 tokens?
```

### Example call

<!-- Compress a long session before sending the next turn -->
```typescript
const result = await mcp.call("conduit_compress", {
  messages: longHistory,   // 40+ turns
  trigger_tokens: 8000,
  keep_recent_turns: 4
});
// result.compressed              → true
// result.stats.compression_ratio → 0.18  (82% reduction)
// result.messages                → [summaryBlock, ...last4turns]
```

> ⚠️ **Note:** Compression requires `ANTHROPIC_API_KEY` to be set for full AI summarization. Without it, a heuristic line-preview fallback is used — no API call is made, but the summary quality is lower.

---

## conduit_handoff

Compress the current conversation into a structured **HandoffContract** for the next agent. Uses `claude-haiku-4-5` to extract task, context, constraints, decisions, and open questions into a JSON contract. Also returns a ready-to-use system prompt the receiving agent can load directly.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from_agent` | `string` | yes | Name of the current (sending) agent |
| `to_agent` | `string` | yes | Name of the receiving agent |
| `task` | `string` | yes | One sentence describing what the receiving agent must do |
| `messages` | `Array<{role, content}>` | yes | Full conversation history to compress |
| `context_hint` | `string` | no | Extra context note forwarded to the compressor |

### Output

```typescript
{
  contract: {
    id: string;              // UUID — use with conduit_fetch_handoff
    from_agent: string;
    to_agent: string;
    ts: number;              // Unix ms
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

### Example call

<!-- Hand off from a planning agent to a coding agent -->
```typescript
const result = await mcp.call("conduit_handoff", {
  from_agent: "PlannerAgent",
  to_agent:   "CoderAgent",
  task:       "Implement the SQLite schema described in the planning session",
  messages:   planningHistory,
  context_hint: "Focus on the requests and cache_events tables"
});

// result.contract.id       → "3f2a1b0c-..."  (store this for reference)
// result.system_prompt     → "## Handoff from PlannerAgent\n\n**Task:** ..."
```

> 💡 **Tip:** Inject `result.system_prompt` as the system prompt of the receiving agent's first request. Use `conduit_fetch_handoff` later to retrieve the full structured contract by ID.

---

## conduit_fetch_handoff

Retrieve a previously created HandoffContract by its ID. Contracts are stored in memory for the lifetime of the conduit process.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `handoff_id` | `string` | yes | UUID returned by `conduit_handoff` |

### Output

On success — the full `HandoffContract` object (same shape as `contract` in `conduit_handoff` output).

On failure — error with `isError: true`:

```json
"Handoff not found: 3f2a1b0c-..."
```

### Example call

```typescript
const contract = await mcp.call("conduit_fetch_handoff", {
  handoff_id: "3f2a1b0c-..."
});
// contract.prior_decisions → ["Use snake_case for all column names", ...]
```

> ⚠️ **Note:** Contracts live in the conduit process's memory. They are lost on server restart. If persistence is needed, serialize `contract` to your own store immediately after `conduit_handoff`.

---

## conduit_feedback

Record quality feedback on a request. Feedback is written to SQLite and used to track which optimization rules are helping or hurting. Rules with a bad rate above 40% (over at least 5 evaluations) are automatically disabled.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `request_id` | `string` | yes | The request ID to rate |
| `rating` | `"good"` \| `"bad"` \| `"partial"` | yes | Quality outcome |
| `rule_suspected` | `string` | no | Optimization rule you suspect caused a problem (e.g. `"cache_system"`) |
| `notes` | `string` | no | Free-text notes |

### Output

Returns the current rule stats report (same as `conduit_rule_stats` with `format: "markdown"`):

```
## Rule Stats

| Rule | Evals | Good | Bad | Partial | Win Rate | Status |
|---|---|---|---|---|---|---|
| `cache_system` | 8 | 6 | 2 | 0 | 75% | ✅ Active |
| `cache_messages` | 5 | 2 | 3 | 0 | 40% | 🚫 Disabled |
```

### Example call

```typescript
// Mark a request as bad, suspecting cache_messages caused the issue
await mcp.call("conduit_feedback", {
  request_id:     "req_abc123",
  rating:         "bad",
  rule_suspected: "cache_messages",
  notes:          "Model ignored cached history and repeated earlier reasoning"
});
```

---

## conduit_rule_stats

Return a summary table of all optimization rules tracked by the feedback loop, including evaluation counts, win/bad rates, and whether each rule has been auto-disabled.

### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `format` | `"json"` \| `"markdown"` | no | `"markdown"` | Output format |

### Output

**Markdown format** (default):

```
## Rule Stats

| Rule | Evals | Good | Bad | Partial | Win Rate | Status |
|---|---|---|---|---|---|---|
| `cache_tools` | 12 | 11 | 1 | 0 | 92% | ✅ Active |
| `cache_system` | 8 | 6 | 2 | 0 | 75% | ✅ Active |
```

**JSON format** — array of `RuleStats` objects:

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

### Example call

```typescript
// Markdown table for a quick status check
const stats = await mcp.call("conduit_rule_stats", {});

// JSON for programmatic inspection
const data = await mcp.call("conduit_rule_stats", { format: "json" });
```

---

## conduit_route_model

Suggest the cheapest capable model for a given prompt. Analyses the prompt for complexity signals and returns a model recommendation with tier, confidence, and reasoning. Does not make any API call — purely heuristic.

### Input

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | `string` | yes | — | The prompt or task description to route |
| `policy` | `"aggressive"` \| `"conservative"` \| `"off"` | no | `"conservative"` | Routing aggressiveness. `aggressive` tries Haiku for simple tasks; `conservative` defaults to Sonnet; `off` always returns Sonnet. |
| `force_model` | `string` | no | — | Override: return this exact model ID regardless of routing logic |

### Routing logic

| Policy | Opus triggers | Haiku triggers | Default |
|---|---|---|---|
| `conservative` | Task keywords (architect, security audit, …) | — | Sonnet |
| `aggressive` | Task keywords + long code prompts (> 4000 chars) | Simple task keywords (format, summarize, …) + short prompts (< 200 chars) | Sonnet |
| `off` | — | — | Sonnet always |

### Output

```typescript
{
  model: string;             // full model ID, e.g. "claude-haiku-4-5-20251001"
  tier: "haiku" | "sonnet" | "opus";
  confidence: number;        // 0–1
  reason: string;            // human-readable explanation
  cost_per_1m_input: number; // USD per 1M input tokens
}
```

### Example call

```typescript
const decision = await mcp.call("conduit_route_model", {
  prompt: "Summarize the following list of errors into bullet points",
  policy: "aggressive"
});
// decision.model      → "claude-haiku-4-5-20251001"
// decision.tier       → "haiku"
// decision.confidence → 0.7
// decision.reason     → 'simple task keyword: "summarize"'

const override = await mcp.call("conduit_route_model", {
  prompt: "...",
  force_model: "claude-opus-4-7"
});
// override.reason → "force_model override"
```

---

## conduit_ab_create

Create a named A/B experiment with two or more instruction variants. Experiments are persisted in SQLite and survive conduit restarts (when `CONDUIT_DB_PATH` is set).

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Unique experiment name |
| `variants` | `Array<{name: string, instruction: string}>` | yes | At least 2 variants. Each has a `name` label and an `instruction` string that will be injected into the agent's prompt. |

### Output

```typescript
{
  id: string;         // UUID
  name: string;
  variants: Array<{ name: string; instruction: string }>;
  created_at: number; // Unix ms
  active: number;     // 1 = active
}
```

### Example call

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

## conduit_ab_assign

Assign a session to a variant in an active experiment. Assignments are deterministic — the same `session_id` always gets the same variant. Returns the `instruction` to inject into the agent's prompt.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session_id` | `string` | yes | Current session identifier |
| `experiment_name` | `string` | yes | Name of an active experiment |

### Output

On success:

```typescript
{
  experiment_id: string;
  variant_name: string;
  instruction: string;   // inject this into the agent's system prompt or first user message
}
```

On failure (experiment not found or inactive) — error with `isError: true`.

### Example call

```typescript
const assignment = await mcp.call("conduit_ab_assign", {
  session_id:       "sess_xyz",
  experiment_name:  "cache-tone-test"
});
// assignment.variant_name → "treatment"
// assignment.instruction  → "Be concise. Think step by step before answering."
```

> 💡 **Tip:** Combine `conduit_ab_assign` with `conduit_feedback` to close the loop: assign a variant at session start, record `conduit_feedback` at the end, then use `conduit_rule_stats` to see which variant performed better.

---

## conduit_ab_list

List all A/B experiments, including inactive ones. Sorted newest-first.

### Input

No parameters.

### Output

Array of `ABExperiment` objects (same shape as `conduit_ab_create` output).

### Example call

```typescript
const experiments = await mcp.call("conduit_ab_list", {});
// [{ id: "...", name: "cache-tone-test", active: 1, variants: [...] }, ...]
```

---

*← [Getting Started](GETTING-STARTED.md) · [Back to README](../README.md) · [Next → Architecture](ARCHITECTURE.md)*
