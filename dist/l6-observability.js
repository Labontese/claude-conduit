import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export class ObservabilityBus {
    db;
    currentSessionId;
    constructor(dbPath = ':memory:') {
        if (dbPath !== ':memory:') {
            mkdirSync(dirname(dbPath), { recursive: true });
        }
        this.db = new Database(dbPath);
        this.initSchema();
        this.currentSessionId = this.startSession();
    }
    initSchema() {
        this.db.exec(`
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
        saved_tokens INTEGER
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
    `);
    }
    startSession(agentName, client) {
        const id = randomUUID();
        this.db
            .prepare(`INSERT INTO sessions (id, started_at, client, agent_name) VALUES (?, ?, ?, ?)`)
            .run(id, Date.now(), client ?? null, agentName ?? null);
        return id;
    }
    recordRequest(record) {
        const id = randomUUID();
        this.db
            .prepare(`INSERT INTO requests (id, session_id, ts, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, latency_ms, cost_usd, baseline_cost_usd,
          optimizations_applied, saved_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, record.sessionId, Date.now(), record.model, record.inputTokens, record.outputTokens, record.cacheReadTokens ?? 0, record.cacheWriteTokens ?? 0, record.latencyMs ?? null, record.costUsd ?? null, record.baselineCostUsd ?? null, record.optimizationsApplied ? JSON.stringify(record.optimizationsApplied) : null, record.savedTokens ?? null);
        return id;
    }
    getSessionReport(sessionId) {
        const sid = sessionId ?? this.currentSessionId;
        const session = this.db
            .prepare(`SELECT * FROM sessions WHERE id = ?`)
            .get(sid);
        if (!session)
            throw new Error(`Session not found: ${sid}`);
        const stats = this.db
            .prepare(`SELECT
          COUNT(*) as count,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read,
          COALESCE(SUM(saved_tokens), 0) as saved_tokens,
          COALESCE(SUM(cost_usd), 0) as cost_usd,
          COALESCE(SUM(baseline_cost_usd), 0) as baseline_cost_usd
        FROM requests WHERE session_id = ?`)
            .get(sid);
        const totalTokens = stats.input_tokens + stats.cache_read;
        const cacheHitRate = totalTokens > 0 ? stats.cache_read / totalTokens : 0;
        return {
            sessionId: sid,
            startedAt: session.started_at,
            requestCount: stats.count,
            totalInputTokens: stats.input_tokens,
            totalOutputTokens: stats.output_tokens,
            totalCacheReadTokens: stats.cache_read,
            totalSavedTokens: stats.saved_tokens,
            totalCostUsd: stats.cost_usd,
            totalBaselineCostUsd: stats.baseline_cost_usd,
            avgCacheHitRate: cacheHitRate,
        };
    }
    formatReport(report) {
        const savings = report.totalBaselineCostUsd > 0
            ? (((report.totalBaselineCostUsd - report.totalCostUsd) /
                report.totalBaselineCostUsd) *
                100).toFixed(1)
            : '0';
        return [
            `## conduit_report — session ${report.sessionId.slice(0, 8)}`,
            '',
            `| Metric | Value |`,
            `|---|---|`,
            `| Requests | ${report.requestCount} |`,
            `| Input tokens | ${report.totalInputTokens.toLocaleString()} |`,
            `| Cache read tokens | ${report.totalCacheReadTokens.toLocaleString()} |`,
            `| Cache hit rate | ${(report.avgCacheHitRate * 100).toFixed(1)}% |`,
            `| Tokens saved | ${report.totalSavedTokens.toLocaleString()} |`,
            `| Est. cost | $${report.totalCostUsd.toFixed(4)} |`,
            `| Baseline cost | $${report.totalBaselineCostUsd.toFixed(4)} |`,
            `| Savings | ${savings}% |`,
        ].join('\n');
    }
    getCurrentSessionId() {
        return this.currentSessionId;
    }
    close() {
        this.db.close();
    }
    getDb() {
        return this.db;
    }
}
