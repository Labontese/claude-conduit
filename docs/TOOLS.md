# Tools Reference

claude-conduit exposes six MCP tools. This document covers every input parameter, output shape, and a worked example for each tool.

---

## Overview

| Tool | Purpose | When to use |
|---|---|---|
| `conduit_search_tools` | Find tools by intent | Before calling a tool you are unsure of |
| `conduit_describe_tool` | Get full schema for one tool | Before executing an unfamiliar tool |
| `conduit_execute_tool` | Run a registered tool | When you know the exact tool name and args |
| `conduit_wrap_request` | Inject cache breakpoints into a request | Every Anthropic API call in a long-running agent |
| `conduit_report` | Session token/cost report | After a batch of requests, or on a schedule |
| `conduit_explain` | Human-readable session summary | Quick status check, end-of-session logging |

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

```typescript
const result = await mcp.call("conduit_search_tools", {
  query: "file",
  max_results: 3
});
```

> **Tip:** Use `conduit_search_tools` at the start of a reasoning step to discover relevant tools without paying for schema tokens. Only fetch the schema with `conduit_describe_tool` when you are ready to call the tool.

---

## conduit_describe_tool

Returns the full JSON schema for a single registered tool, including its `inputSchema`.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Exact tool name as returned by `conduit_search_tools` |

### Output

On success — JSON object with `name`, `description`, and `inputSchema`:

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

```typescript
const result = await mcp.call("conduit_execute_tool", {
  name: "list_files",
  args: { path: "./src", recursive: false }
});
```

> **Note:** If `args` is omitted, conduit passes an empty object `{}` to the tool handler.

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

### Pricing reference (used for saved_usd_estimated)

| Model | Input price per 1M tokens |
|---|---|
| claude-opus-4-7 | $15.00 |
| claude-sonnet-4-6 | $3.00 |
| claude-haiku-4-5 | $0.80 |
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

```markdown
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

```typescript
// Markdown (default)
const report = await mcp.call("conduit_report", {});

// JSON for programmatic use
const data = await mcp.call("conduit_report", { format: "json" });
```

> **Note:** `conduit_report` reads from the SQLite database. If conduit is running with the default in-memory store (no `CONDUIT_DB_PATH`), data is lost when the server restarts. Set `CONDUIT_DB_PATH` for persistent reporting.

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

```typescript
const summary = await mcp.call("conduit_explain", {});
console.log(summary);
```
