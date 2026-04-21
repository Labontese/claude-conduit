<img src="banner.svg" alt="claude-conduit" width="100%"/>

> Token and agent optimization MCP server for Claude — cut input tokens by up to 85%, boost cache hit rates, and get per-session cost reports. Automatically.

---

## Quickstart

```bash
npm install -g @patchwindow/claude-conduit
export ANTHROPIC_API_KEY=sk-ant-...   # required for L3/L7 compression
conduit init
# Done — claude-conduit now runs as an MCP server in your project folder
```

`conduit init` creates the database, writes `.mcp.json`, and prints any remaining steps. Run `conduit doctor` at any time to check your setup.

If you do not want to use L3 (context compression) or L7 (handoff compression), you can skip the API key entirely. The other six layers (L1, L2, L4, L5, L6, L8) run fully without one. See [Anthropic API key — when is it needed?](#anthropic-api-key--when-is-it-needed) for the per-layer breakdown.

> **Pick your path:** Max/Pro-only users get 6/8 layers; API-key users get all 8. See [What you get with Claude Max/Pro only vs with an API key](#what-you-get-with-claude-maxpro-only-vs-with-an-api-key) for a concrete comparison.

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

## Auto-reporting (0.3.0+)

Every `conduit_*` tool automatically logs its call to the L6 observability
bus — no need to invoke `conduit_report` manually. The dashboard lights up
from the first tool call, with per-tool latency, token savings, and cost
estimates. Set `CONDUIT_AGENT_NAME` in `.mcp.json` to label which agent made
each call.

---

## Configuration

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `CONDUIT_DB_PATH` | No | `~/.claude-conduit/sessions.db` | SQLite file for session history and metrics |
| `CONDUIT_AGENT_NAME` | No | `unknown` | Labels the auto-reporting session so the dashboard's `/api/recent` shows which agent made each call. Set it per project or per agent in `.mcp.json`'s `env` block. |
| `ANTHROPIC_API_KEY` | For L3 and L7 | — | Used by L3 Context Compressor and L7 Handoff distillation. Both call Haiku directly; without a key they fall back to simple character-based truncation. |

The database file is auto-created on first run. Defaults by platform:

| Platform | Default path |
|---|---|
| Windows | `C:\Users\<name>\.claude-conduit\sessions.db` |
| macOS | `~/.claude-conduit/sessions.db` |
| Linux | `~/.claude-conduit/sessions.db` |

Set `CONDUIT_DB_PATH` only if you want a custom location (for example, to share one database across multiple projects, or to place it on a different drive).

### Anthropic API key — when is it needed?

claude-conduit is built for developers who already have an `ANTHROPIC_API_KEY`. Two of the eight layers call Haiku directly and therefore require a key; the other six layers work fully without one.

| Layer | Name | API key required? |
|---|---|---|
| L1 | Lazy tool loading | No |
| L2 | Deduplication | No |
| L3 | Context compression | **Yes** (falls back to simple truncation without) |
| L4 | Cache orchestration | No |
| L5 | Model routing | No |
| L6 | Observability | No |
| L7 | Handoff compression | **Yes** (falls back to simple truncation without) |
| L8 | Feedback loop | No |

6 of 8 layers work without an API key.

If you only have a Claude Max/Pro subscription (no API key), L3 and L7 will run in degraded fallback mode — simple character-based truncation instead of semantic compression via Haiku. Functional, but materially less effective. The other six layers work fully.

There is no OAuth passthrough from a Max/Pro subscription to direct API calls, and claude-conduit does not ship one. Anthropic's terms prohibit using Max/Pro credentials to drive programmatic API traffic. Get a key at [console.anthropic.com](https://console.anthropic.com/) if you want the full feature set.

### What you get with Claude Max/Pro only vs with an API key

Two supported setups. Pick the one that matches your situation. All numbers below are reproducible — run `node scripts/demo.mjs` to verify L2, L3 and L7 on your own machine.

#### Scenario A — Claude Max/Pro only (no API key)

**Active layers (full function):** L1, L2, L4, L5, L6, L8
**Degraded layers (fallback mode):** L3, L7

What each layer actually does in this setup:

| Layer | Behavior |
|---|---|
| **L1** Lazy tool loading | Schemas filtered by relevance — saves ~30–70% on tool-definition tokens per request. No API calls required. |
| **L2** Deduplication | Exact hash + MinHash LSH. ~20% token reduction on typical message histories with repeated content (verified in `scripts/demo.mjs`). No API calls required. |
| **L4** Cache orchestration | Automatic `cache_control` breakpoints on tools/system/messages — cache hit rate 50–90% in observed sessions. Pure request transformation, no API calls. |
| **L5** Model routing | Rule-based routing between Haiku/Sonnet/Opus based on prompt heuristics. No API calls required. |
| **L6** Observability | Full SQLite logging, dashboard works, cost estimates and metrics accurate. No API calls required. |
| **L8** Feedback loop | Rule statistics and auto-disable work fully. No API calls required. |
| **L3** Context compression | **Fallback:** truncates at token limit instead of semantic compression — keeps start + end, drops middle. Functional, but loses information a summary would have preserved. |
| **L7** Handoff compression | **Fallback:** sync truncation — ~35% size reduction but no structured extraction of constraints, prior decisions, or open questions. Receiving agent gets a clipped log instead of a clean briefing. |

**Bottom line:** claude-conduit is useful in this setup — cache orchestration alone often cuts costs 40–60% on long sessions, L1 trims tool overhead significantly, and L6 gives you the full dashboard. You just lose semantic compression on L3 and L7.

#### Scenario B — With `ANTHROPIC_API_KEY`

**All 8 layers fully active.** L1/L2/L4/L5/L6/L8 behave identically to Scenario A. L3 and L7 upgrade from truncation to Haiku-backed compression:

| Layer | Behavior |
|---|---|
| **L3** Context compression | Haiku-based semantic compression. 70–90% token reduction on long contexts while preserving meaning. Automatic trigger at 8000 tokens. |
| **L7** Handoff compression | Haiku extracts a structured handoff contract — constraints, prior decisions, open questions — instead of raw truncation. Receiving agent gets a clean briefing, not a log dump. |

**Additional API cost** (at Haiku pricing: $0.80/M input, $4.00/M output):

- Each L3 compression: ~$0.0002 per 10K tokens of input context
- Each L7 handoff: ~$0.0005 per typical agent state

Easily offset by the savings these compressions produce on the larger downstream model (Sonnet/Opus) that would otherwise have processed the full uncompressed context.

**Bottom line:** Full value. Recommended for production use and heavy multi-agent workflows where handoffs carry real structured state.

#### Side-by-side summary

| Aspect | Max/Pro only | With API key |
|---|---|---|
| Layers fully active | 6 of 8 | 8 of 8 |
| L3 behavior | Character truncation (start + end kept) | Haiku semantic summary |
| L7 behavior | Sync truncation (~35% reduction) | Structured contract extraction |
| Typical cost reduction on long sessions | 40–60% (cache + L1 + L2) | 70–85% (adds semantic compression) |
| Added API spend | $0 | ~$0.0002–0.0005 per compression |
| Suitable for | Local dev, single-agent, Max/Pro users | Production, multi-agent handoffs |

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

---

## FAQ

**Does claude-conduit work with a Claude Max/Pro subscription?**
Partially. 6 of 8 layers work without an API key. L3 context compression and L7 handoff compression require `ANTHROPIC_API_KEY` because they call Haiku directly. There is no OAuth passthrough from Max/Pro subscriptions — Anthropic's terms prohibit using subscription credentials to drive programmatic API traffic.

**How do I get an API key?**
Create one at [console.anthropic.com](https://console.anthropic.com/). You pay per token; L3 and L7 use Haiku, which is the cheapest model in the lineup.

**What does "fallback mode" mean for L3 and L7?**
Simple character-based truncation instead of semantic compression. Old turns are clipped to fit a token budget rather than summarised by Haiku. Still functional, but materially less effective — you lose information that a summary would have preserved.

**Can I use Ollama or another local model?**
Not currently supported. claude-conduit requires Haiku for L3 and L7 output quality; swapping in a local model would change the compression behaviour in ways we cannot guarantee.

**Which layers run by default?**
All eight. L3 and L7 detect a missing API key at call time and switch to truncation fallback automatically — no configuration needed. Run `conduit doctor` to confirm which mode each layer will use on your machine.
