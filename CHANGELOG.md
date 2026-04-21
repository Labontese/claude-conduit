# Changelog

All notable changes to `@patchwindow/claude-conduit` are documented here.
Dates are ISO 8601 (YYYY-MM-DD).

## Unreleased

- Docs: Clarified API key requirement for L3/L7; added FAQ and per-layer requirement table.
- Docs: Added detailed Max/Pro vs API-key comparison section with concrete per-layer behavior, fallback semantics, Haiku cost estimates, and a side-by-side summary table. Added "Pick your path" callout in Quickstart.

## 0.4.0 — 2026-04-21

- **UX: Task-oriented tool names.** Based on Anna's UX audit, ten tools have
  been renamed to match user mental models. All old names remain as
  deprecated aliases — no breaking changes.

  | Old name | New canonical name |
  |---|---|
  | `conduit_wrap_request` | `conduit_optimize_request` |
  | `conduit_execute_tool` | `conduit_call_tool` |
  | `conduit_rule_stats` | `conduit_optimization_stats` |
  | `conduit_ab_assign` | `conduit_ab_get_variant` |
  | `conduit_compress` | `conduit_summarize_history` |
  | `conduit_deduplicate` | `conduit_dedupe` |
  | `conduit_handoff` | `conduit_handoff_pack` |
  | `conduit_fetch_handoff` | `conduit_handoff_load` |
  | `conduit_report` | `conduit_cost_report` |
  | `conduit_explain` | `conduit_explain_request` |

  Deprecated aliases will be removed in the next major version. Migrate
  at your convenience.

- **UX: String-friendly inputs.** `conduit_dedupe` and
  `conduit_summarize_history` now accept `items: string[]` as well as the
  legacy `{role, content}[]` form. Strings are wrapped internally with
  `role: "user"`. `conduit_handoff_pack` accepts the same.

- **UX: `conduit_dedupe` return modes.** New `return` parameter —
  `"clean"` (default) removes duplicates entirely; `"annotated"` keeps
  them with `[duplicate of: hash]` markers (previous behaviour).
  Case-insensitive by default (`case_sensitive: false`) — hashes
  `.toLowerCase().trim()` so `"Hello"` and `"HELLO"` merge.

- **UX: Compression presets.** `conduit_summarize_history` accepts
  `preset: "aggressive" | "balanced" | "light"`, each setting sensible
  `trigger_tokens`/`keep_recent_turns`. Explicit overrides still win.
  Default is `"balanced"` which matches 0.3.0 behaviour.

- **UX: Optional handoff metadata.** `conduit_handoff_pack` treats
  `from_agent` and `to_agent` as optional — only `task` and `messages`
  are required.

- **UX: `conduit_optimize_request` minimal form.** Besides the full
  Anthropic request object, the tool now accepts `{model, messages}`
  and wraps it to a cache-breakpointed request.

- **Internal:** Tool registration moved out of `src/index.ts` into a
  pure `src/tool-definitions.ts` module. `buildToolSurface(deps)`
  returns the full tool list for test inspection without spinning up an
  MCP transport. No runtime behaviour change.

## 0.3.0 — 2026-04-21

- **Feature:** Auto-reporting — alla `conduit_*`-tools loggar nu automatiskt
  till L6 via en ny middleware (`src/reporting-middleware.ts`). Dashboarden
  visar aktivitet utan att `conduit_report` behöver anropas manuellt.
  Varje anrop registrerar tool-namn, latency, tokens och besparingar som
  kan extraheras ur resultatet (dedup/compress/handoff/wrap). Anrop som
  saknar metrics loggas ändå som aktivitet med `model = "n/a"`.
- **Feature:** `requests`-tabellen har två nya kolumner: `tool_name` och
  `error`. Existerande DB-filer migreras automatiskt via
  `ensureSchema()` (ADD COLUMN IF NOT EXISTS-semantik via PRAGMA-check).
- **Feature:** Servern startar nu en session märkt med `agent_name` från
  miljövariabeln `CONDUIT_AGENT_NAME` (default `unknown`). Sätt den i
  `.mcp.json`:s `env`-block för att se agent-namn i dashboardens
  `/api/recent`.
- **Fix (Novas fynd):** L2-deduplikering rapporterade `strategy_used: 'exact'`
  så snart en exakt match sågs, även om MinHash också triggats för andra
  block. Nu returnerar vi `'mixed'` när båda strategierna användes,
  annars `'exact'`, `'minhash'` eller `'none'`. Typen utökad.

## 0.2.2 — 2026-04-21

- **Fix:** Dashboard crashed with `SqliteError: no such table: rule_stats`
  when `GET /api/rules` was the first query on a DB that no MCP tool had
  initialised. The dashboard now calls a shared `ensureSchema(db)` at
  startup that creates every table any layer uses. Per-layer DDL is kept
  as idempotent defence in depth.
- **Fix:** API handlers in the dashboard are now wrapped in try/catch.
  Database errors return `500 { error }` JSON instead of killing the HTTP
  server.
- **Internal:** New `src/db-schema.ts` centralises all DDL. Both the MCP
  server and the dashboard server call `ensureSchema()` after opening the
  database.

## 0.2.1 — 2026-04-21

- **Docs:** Fully rewritten README with Quickstart, Configuration, CLI
  reference, and Troubleshooting sections.
- **Packaging:** `CHANGELOG.md` and `banner.svg` are now included in the
  published npm tarball (0.2.0 shipped without them).

## 0.2.0 — 2026-04-21

- **Smart defaults:** `CONDUIT_DB_PATH` is no longer required. When unset, the
  server uses `~/.claude-conduit/sessions.db` (Windows:
  `C:\Users\<name>\.claude-conduit\sessions.db`) and auto-creates the directory
  and file on first run.
- **New:** `conduit init` — one-shot setup. Creates the database, writes or
  updates `.mcp.json`, and prints any remaining steps. `--yes` accepts all
  defaults non-interactively.
- **New:** `conduit doctor` — diagnoses the install: database reachable,
  `ANTHROPIC_API_KEY` present for L3 and L7, `.mcp.json` valid, Node ≥ 20.
- **Fix:** The dashboard no longer opens the database with `readonly: true`,
  which blocked auto-creation of a missing file. Dashboard handlers only run
  SELECTs, so this is safe. The dashboard also falls back to the same default
  path as the server when neither CLI arg nor `CONDUIT_DB_PATH` is provided.
- **Internal:** New `src/db-path.ts` with `resolveDbPath()` shared by
  `index.ts` and `dashboard-server.ts`.
- **Compatibility:** `CONDUIT_DB_PATH` still wins over the default when set.

## 0.1.3 — 2026-04-21

- **Fix:** Dashboard crashed when pointed at `:memory:` or a read-only path.

## 0.1.2 and earlier

- Initial release. Layers L1–L8 implemented: lazy tool registry, semantic
  deduplication, context compression, cache orchestration, model router + A/B
  testing, observability bus, agent handoff compressor, feedback loop.
