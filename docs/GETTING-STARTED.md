# Getting Started with claude-conduit

claude-conduit is an MCP server that sits between your Claude agents and the Anthropic API. It automatically injects prompt cache breakpoints, resolves tool schemas on demand, and tracks token usage per session — with no changes to your agent logic required.

---

## Prerequisites

- Node.js 18 or later
- An Anthropic API key
- Claude Code or another MCP-compatible client

---

## Installation

### Global install (recommended)

```bash
npm install -g @teamdaniel/claude-conduit
```

### Local install

```bash
npm install @teamdaniel/claude-conduit
npm run build
```

---

## Configure Claude Code

Add conduit to your `.mcp.json` file. By default, conduit uses an in-memory SQLite database. To persist session data across restarts, set `CONDUIT_DB_PATH`.

**In-memory (ephemeral — sessions lost on restart):**

```json
{
  "mcpServers": {
    "conduit": {
      "command": "node",
      "args": ["/path/to/claude-conduit/dist/index.js"]
    }
  }
}
```

**Persistent sessions:**

```json
{
  "mcpServers": {
    "conduit": {
      "command": "node",
      "args": ["/path/to/claude-conduit/dist/index.js"],
      "env": {
        "CONDUIT_DB_PATH": "/home/user/.conduit/sessions.db"
      }
    }
  }
}
```

> **Tip:** The directory for `CONDUIT_DB_PATH` is created automatically if it does not exist.

After editing `.mcp.json`, restart Claude Code to load the server.

---

## Your first optimization

The core workflow is: wrap your Anthropic request through conduit before sending it. Conduit adds `cache_control` breakpoints to tools, system prompt, and conversation history — then returns both the optimized request and savings metadata.

```typescript
// Step 1: build your request as normal
const request = {
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  system: "You are a helpful coding assistant with access to a broad set of tools. " +
          "Always reason step by step before calling a tool. " +
          // ... long system prompt (must be >= 1024 tokens to trigger cache) ...
          "",
  messages: [
    { role: "user", content: "What files are in the src directory?" },
    { role: "assistant", content: "Let me check." },
    { role: "user", content: "Please list them with their sizes." },
    { role: "user", content: "And tell me which is the largest." },
  ],
  tools: [
    {
      name: "list_files",
      description: "List files in a directory",
      input_schema: { type: "object", properties: { path: { type: "string" } } }
    }
  ]
};

// Step 2: call conduit_wrap_request
const result = await mcp.call("conduit_wrap_request", { request });

// result.request  — optimized Anthropic request, ready to send
// result.meta     — CacheMeta with token savings breakdown

console.log(result.meta.optimizations_applied);
// ["cache_tools", "cache_system", "cache_messages"]

console.log(result.meta.cache_breakpoints);
// 3

console.log(`Estimated savings: $${result.meta.saved_usd_estimated.toFixed(6)}`);

// Step 3: send result.request to Anthropic as-is
const response = await anthropic.messages.create(result.request);
```

> **Note:** `cache_messages` only fires when the conversation has 4 or more messages. `cache_system` only fires when the system prompt is 1 024 tokens or longer (Anthropic's minimum cacheable block size).

---

## Verify it is working

After a few requests, call `conduit_report` to see a session summary:

```typescript
const report = await mcp.call("conduit_report", { format: "markdown" });
console.log(report);
```

Expected output:

```
## conduit_report — session a3f2c1b0

| Metric            | Value    |
|-------------------|----------|
| Requests          | 5        |
| Input tokens      | 12,400   |
| Cache read tokens | 9,100    |
| Cache hit rate    | 73.4%    |
| Tokens saved      | 8,800    |
| Est. cost         | $0.0103  |
| Baseline cost     | $0.0372  |
| Savings           | 72.3%    |
```

For a plain English summary, call `conduit_explain`:

```typescript
const explain = await mcp.call("conduit_explain", {});
// "conduit has processed 5 request(s) this session.
//  Cache hit rate: 73.4%
//  Estimated token reduction: 72.3%
//  Estimated cost saved: $0.0269"
```

---

## Troubleshooting

### "Session not found" error from conduit_report

This happens when `CONDUIT_DB_PATH` points to a file from a previous run and the session UUID no longer exists. Either omit `session_id` (conduit uses the current session automatically) or remove the stale `.db` file.

### cache_system is never applied

The system prompt must be **at least 1 024 tokens** for Anthropic to allow caching. For short system prompts conduit logs a note: `"System prompt under 1024 token minimum — cache skipped"`. Check `result.meta.notes` if a breakpoint is missing.

### cache_messages is not applied

The messages array needs **4 or more messages** before conduit places a breakpoint on the final user turn. This prevents wasteful cache writes on single-turn exchanges.

### The MCP server does not appear in Claude Code

1. Confirm the path in `args` points to the compiled `dist/index.js` (run `npm run build` first).
2. Check that Node.js is on the `PATH` used by Claude Code.
3. Restart Claude Code — MCP servers are loaded at startup.

### conduit_wrap_request returns the request unchanged

Check `result.meta.optimizations_applied` — it will be an empty array `[]` if all three optimizations were skipped. Look at `result.meta.notes` for the reason. Common causes: short system prompt, fewer than 4 messages, no tools array.
