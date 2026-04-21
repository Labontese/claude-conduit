<img src="banner.svg" alt="claude-conduit" width="100%"/>

> Token and agent optimization MCP server for Claude — cut input tokens by up to 85%, boost cache hit rates, and get per-session cost reports. Automatically.

---

## At a glance

| Metric | Target |
|---|---|
| Input token reduction | **~85%** (warm cache, tool-heavy agent) |
| Cache hit rate | **~74%** |
| Cost reduction | **~70–80%** |
| Latency overhead | **< 5 ms** |

> ⚠️ **Note:** These are design targets, not yet formally measured. See [docs/BENCHMARKS.md](docs/BENCHMARKS.md) for methodology and the results placeholder.

---

## How it works

```
1. You build an Anthropic request (model, system, messages, tools)
          ↓
2. conduit_wrap_request() injects cache_control breakpoints
   — last tool, system prompt block, last user message
          ↓
3. You send the optimized request to Anthropic directly
```

conduit does **not** sit in the HTTP path. It transforms request objects in memory and hands them back. Your agent owns the API call.

---

## Quick install

```bash
npm install -g @teamdaniel/claude-conduit
```

Add to your Claude Code config:

<!-- .mcp.json — persistent sessions -->
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

> 💡 **Tip:** Omit `CONDUIT_DB_PATH` for an in-memory store (data lost on restart). Set it to keep session history across restarts.

---

## Usage

<!-- Optimize a request and inspect savings -->
```typescript
const result = await conduit_wrap_request({
  request: {
    model: "claude-sonnet-4-6",
    system: "You are a helpful assistant...",
    messages: [...],
    tools: [...]
  }
});

// result.request → optimized request with cache_control breakpoints
// result.meta    → { saved_tokens, saved_usd_estimated, optimizations_applied, ... }

// Check session stats
await conduit_report();

// Search available tools without loading schemas
await conduit_search_tools({ query: "file" });
```

---

## Tools

| Tool | Purpose | When to use |
|---|---|---|
| `conduit_wrap_request` | 🔧 Inject cache breakpoints | Before every Anthropic API call in a long-running agent |
| `conduit_search_tools` | 🔍 Find tools by intent | Before calling a tool you are unsure of |
| `conduit_describe_tool` | 📋 Get full schema for one tool | Before executing an unfamiliar tool |
| `conduit_execute_tool` | ▶️ Run a registered tool | When you know the exact tool name and args |
| `conduit_report` | 📊 Session cost and token report | After a batch of requests, or on a schedule |
| `conduit_explain` | 💬 Human-readable session summary | Quick status check, end-of-session logging |
| `conduit_deduplicate` | 🧹 Remove duplicate messages | Before sending long conversations with repeated content |
| `conduit_compress` | 🗜️ Summarize old conversation turns | When context exceeds your token budget |
| `conduit_handoff` | 🤝 Create agent handoff contract | When handing off work between agents |
| `conduit_fetch_handoff` | 📥 Retrieve a handoff contract | On agent startup, when receiving a handoff |
| `conduit_feedback` | ⭐ Rate a request's quality | After observing a good or bad optimization outcome |
| `conduit_rule_stats` | 📈 View optimization rule health | To track which rules help or hurt |
| `conduit_route_model` | 🧭 Pick cheapest capable model | Before every Anthropic API call to minimize cost |
| `conduit_ab_create` | 🧪 Create an A/B experiment | When testing two instruction variants |
| `conduit_ab_assign` | 🎲 Assign a session to a variant | At the start of a session in an active experiment |
| `conduit_ab_list` | 📋 List all experiments | To inspect active and past experiments |

---

## Architecture

Eight layers across Phases 1–4:

| Layer | Name | Role |
|---|---|---|
| **L1** | Lazy Tool Registry | Tools load on demand — no upfront schema overhead |
| **L2** | Semantic Deduplicator | Removes exact and near-duplicate message blocks |
| **L3** | Context Compressor | Summarises old turns via Haiku, keeps recent N verbatim |
| **L4** | Cache Orchestrator | Injects `cache_control` breakpoints on tools, system, and history |
| **L5** | Model Router + A/B Testing | Routes prompts to cheapest capable model; runs instruction experiments |
| **L6** | Observability Bus | SQLite-backed session tracking with cost estimates |
| **L7** | Agent Handoff Compressor | Distils conversations into structured handoff contracts between agents |
| **L8** | Feedback Loop | Records quality ratings; auto-disables underperforming rules |

---

## Documentation

| Page | Description |
|---|---|
| [Getting Started](docs/GETTING-STARTED.md) | Installation, configuration, first optimization |
| [Tools Reference](docs/TOOLS.md) | All six tools — inputs, outputs, and examples |
| [Architecture](docs/ARCHITECTURE.md) | Layer design, request flow, SQLite schema |
| [Benchmarks](docs/BENCHMARKS.md) | Design targets, methodology, results placeholder |
