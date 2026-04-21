<img src="banner.svg" alt="claude-conduit" width="100%"/>

> Token and agent optimization MCP server for Claude — cut input tokens by up to 85%, boost cache hit rates, and get per-session cost reports. Automatically.

---

## Quickstart

```bash
npm install -g @patchwindow/claude-conduit
conduit init
# Done — claude-conduit now runs as an MCP server in your project folder
```

`conduit init` creates the database, writes `.mcp.json`, and prints any remaining steps. Run `conduit doctor` at any time to check your setup.

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

## Configuration

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `CONDUIT_DB_PATH` | No | `~/.claude-conduit/sessions.db` | SQLite file for session history and metrics |
| `ANTHROPIC_API_KEY` | For L3 only | — | Used by L3 Context Compressor (Haiku) and L7 Handoff distillation |

The database file is auto-created on first run. Defaults by platform:

| Platform | Default path |
|---|---|
| Windows | `C:\Users\<name>\.claude-conduit\sessions.db` |
| macOS | `~/.claude-conduit/sessions.db` |
| Linux | `~/.claude-conduit/sessions.db` |

Set `CONDUIT_DB_PATH` only if you want a custom location (for example, to share one database across multiple projects, or to place it on a different drive).

### Manual `.mcp.json` entry

If you prefer to configure Claude Code by hand rather than running `conduit init`, add this to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "conduit": {
      "command": "npx",
      "args": ["-y", "@patchwindow/claude-conduit"]
    }
  }
}
```

To pin a custom database path:

```json
{
  "mcpServers": {
    "conduit": {
      "command": "npx",
      "args": ["-y", "@patchwindow/claude-conduit"],
      "env": {
        "CONDUIT_DB_PATH": "/absolute/path/to/sessions.db"
      }
    }
  }
}
```

---

## CLI reference

| Command | Purpose |
|---|---|
| `conduit init [--yes]` | One-shot setup: create DB, write `.mcp.json`, print next steps. `--yes` accepts all defaults non-interactively. |
| `conduit doctor` | Diagnose your install: DB reachable? `ANTHROPIC_API_KEY` set? `.mcp.json` valid? Node version ≥ 20? |
| `conduit-dashboard [db-path] [port]` | Start the read-only metrics dashboard (default port `4747`). `db-path` falls back to `CONDUIT_DB_PATH`, then the platform default. |

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

## Troubleshooting

**The dashboard shows zero sessions.**
The MCP server and the dashboard must read and write the same SQLite file. Run `conduit doctor` to see which path each process resolves to, then set `CONDUIT_DB_PATH` consistently (or remove it everywhere to use the default).

**`better-sqlite3` fails with `ENOENT` or a native-module error.**
Run `conduit init`. It ensures the database directory exists and verifies that the native binding loaded correctly on your platform.

**Claude Code does not see the conduit server.**
Run `conduit doctor` — it validates `.mcp.json` and reports the exact problem. If you wrote `.mcp.json` by hand, confirm the file lives at your project root and that Claude Code has been restarted since the last edit.

**Node version error on startup.**
claude-conduit requires Node.js 20 or newer. Upgrade via `nvm install 20` (macOS/Linux) or the official installer (Windows), then reinstall globally.

**Custom database path not picked up.**
`CONDUIT_DB_PATH` must be set in the environment that actually launches the MCP server — for Claude Code, that means the `env` block in `.mcp.json`, not your shell profile.

---

## Documentation

| Page | Description |
|---|---|
| [Getting Started](docs/GETTING-STARTED.md) | Installation, configuration, first optimization |
| [Tools Reference](docs/TOOLS.md) | All six tools — inputs, outputs, and examples |
| [Architecture](docs/ARCHITECTURE.md) | Layer design, request flow, SQLite schema |
| [Benchmarks](docs/BENCHMARKS.md) | Design targets, methodology, results placeholder |
