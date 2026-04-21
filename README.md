# claude-conduit

A token- and agent-optimization MCP server for Claude. Cut input tokens by up to 85%, boost cache hit rates, and get per-session cost reports — automatically.

## Install

```bash
npm install -g @teamdaniel/claude-conduit
```

Add to your Claude Code config (`.mcp.json`):

```json
{
  "mcpServers": {
    "conduit": {
      "command": "node",
      "args": ["path/to/claude-conduit/dist/index.js"],
      "env": {
        "CONDUIT_DB_PATH": "/path/to/conduit.db"
      }
    }
  }
}
```

## Usage

```typescript
// Optimize an Anthropic request before sending
const result = await conduit_wrap_request({
  request: {
    model: "claude-sonnet-4-6",
    system: "You are a helpful assistant...",
    messages: [...],
    tools: [...]
  }
});

// result.request → optimized request with cache_control breakpoints
// result.meta → { saved_tokens, saved_usd_estimated, optimizations_applied, ... }

// Check session stats
await conduit_report();

// Search available tools without loading schemas
await conduit_search_tools({ query: "file" });
```

## Tools

| Tool | Description |
|---|---|
| `conduit_wrap_request` | Optimize an Anthropic API request with cache breakpoints |
| `conduit_search_tools` | Search registered tools by intent (no schemas loaded) |
| `conduit_describe_tool` | Get full schema for a specific tool |
| `conduit_execute_tool` | Execute a registered tool |
| `conduit_report` | Session cost and token usage report |
| `conduit_explain` | Human-readable summary of current session optimizations |

## Architecture

Three layers ship in Fas 1:

- **L1 Lazy Tool Registry** — tools load on demand, not upfront
- **L4 Cache Orchestrator** — automatic `cache_control` breakpoints on tools, system prompt, and conversation history  
- **L6 Observability Bus** — SQLite-backed session tracking with cost estimates

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full design.
