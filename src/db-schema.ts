import Database from 'better-sqlite3';

/**
 * Centraliserad DDL för alla tabeller som används av claude-conduit.
 *
 * Bakgrund:
 * Varje lager (L5 A/B, L6 observability, L8 feedback) kör sin egen
 * `initSchema()` först när lagret konstrueras. MCP-servern instansierar
 * alla lager vid uppstart, men dashbords-servern öppnar DB:n direkt och
 * frågar t.ex. `SELECT * FROM rule_stats` utan att någon L8-init har
 * körts. Resultat: `SqliteError: no such table: rule_stats` och hela
 * HTTP-servern kraschar.
 *
 * `ensureSchema(db)` kör all DDL som en idempotent operation. Både
 * MCP-servern och dashboarden anropar den direkt efter att de öppnat
 * DB:n. DDL:en i respektive lager är kvar (idempotent `IF NOT EXISTS`)
 * som extra säkerhet, men sanningen för schemat bor här.
 */
export function ensureSchema(db: Database.Database): void {
  db.exec(`
    -- L6 ObservabilityBus
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      client TEXT,
      agent_name TEXT,
      model_default TEXT,
      ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      latency_ms INTEGER,
      cost_usd REAL,
      baseline_cost_usd REAL,
      optimizations_applied TEXT,
      saved_tokens INTEGER,
      tool_name TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS cache_events (
      request_id TEXT NOT NULL REFERENCES requests(id),
      breakpoint_index INTEGER NOT NULL,
      placed_at TEXT NOT NULL,
      hit INTEGER,
      tokens_covered INTEGER,
      PRIMARY KEY (request_id, breakpoint_index)
    );
    CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
    CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);

    -- L8 FeedbackLoop
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      rating TEXT NOT NULL,
      rule_suspected TEXT,
      notes TEXT,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rule_stats (
      rule_name TEXT PRIMARY KEY,
      evaluations INTEGER DEFAULT 0,
      wins_good INTEGER DEFAULT 0,
      wins_bad INTEGER DEFAULT 0,
      wins_partial INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      auto_disabled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_rule ON feedback(rule_suspected);
    CREATE INDEX IF NOT EXISTS idx_feedback_request ON feedback(request_id);

    -- L5 A/B Testing
    CREATE TABLE IF NOT EXISTS ab_experiments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      variants TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ab_assignments (
      session_id TEXT NOT NULL,
      experiment_id TEXT NOT NULL,
      variant_name TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, experiment_id)
    );
  `);

  // Migration: äldre DB-filer (pre-0.3.0) saknar tool_name / error på
  // requests-tabellen. SQLite har ingen "ADD COLUMN IF NOT EXISTS", så vi
  // kollar PRAGMA och lägger till defensivt. Både för persistenta och
  // in-memory DB:n — idempotent eftersom vi hoppar över om kolumnen finns.
  const cols = db
    .prepare(`PRAGMA table_info(requests)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('tool_name')) {
    db.exec(`ALTER TABLE requests ADD COLUMN tool_name TEXT`);
  }
  if (!names.has('error')) {
    db.exec(`ALTER TABLE requests ADD COLUMN error TEXT`);
  }
}
