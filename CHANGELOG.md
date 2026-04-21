# Changelog

All notable changes to `@patchwindow/claude-conduit` are documented here.
Dates are ISO 8601 (YYYY-MM-DD).

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
