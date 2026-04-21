import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/db-schema.js';

/**
 * Regression test för buggen i 0.2.2:
 * Dashboarden kraschade när den öppnade en DB-fil där inget MCP-tool hade
 * körts först (ingen L8-init → ingen `rule_stats`-tabell).
 *
 * Testet replikerar dashboardens SELECT-logik mot en tom DB som bara har
 * gått igenom `ensureSchema()`. Alla tre endpoints ska svara utan crash.
 */

// Speglar apiHandler i src/dashboard-server.ts — vi kan inte importera den
// direkt eftersom filen startar en HTTP-server vid module load.
function apiHandler(db: Database.Database, pathname: string): unknown {
  if (pathname === '/api/summary') {
    const sessions = db.prepare(`SELECT COUNT(*) as count FROM sessions`).get() as { count: number };
    const requests = db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read,
        COALESCE(SUM(saved_tokens), 0) as saved_tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COALESCE(SUM(baseline_cost_usd), 0) as baseline_cost_usd
      FROM requests
    `).get() as Record<string, number>;

    const totalTokens = requests['input_tokens'] + requests['cache_read'];
    const cacheHitRate = totalTokens > 0 ? requests['cache_read'] / totalTokens : 0;
    const savings = requests['baseline_cost_usd'] > 0
      ? ((requests['baseline_cost_usd'] - requests['cost_usd']) / requests['baseline_cost_usd'] * 100)
      : 0;

    return { sessions: sessions.count, requests, cacheHitRate, savings };
  }

  if (pathname === '/api/recent') {
    return db.prepare(`
      SELECT r.*, s.agent_name
      FROM requests r
      LEFT JOIN sessions s ON s.id = r.session_id
      ORDER BY r.ts DESC LIMIT 20
    `).all();
  }

  if (pathname === '/api/rules') {
    return db.prepare(`SELECT * FROM rule_stats ORDER BY evaluations DESC`).all();
  }

  return null;
}

describe('Dashboard — schema resilience', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('ensureSchema creates all tables the dashboard queries', () => {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('requests');
    expect(names).toContain('rule_stats');
    expect(names).toContain('feedback');
    expect(names).toContain('ab_experiments');
    expect(names).toContain('ab_assignments');
    expect(names).toContain('cache_events');
  });

  it('/api/summary returns zero-state on empty DB without crashing', () => {
    const result = apiHandler(db, '/api/summary') as {
      sessions: number;
      cacheHitRate: number;
      savings: number;
      requests: Record<string, number>;
    };
    expect(result.sessions).toBe(0);
    expect(result.requests['count']).toBe(0);
    expect(result.cacheHitRate).toBe(0);
    expect(result.savings).toBe(0);
  });

  it('/api/recent returns empty array on empty DB without crashing', () => {
    const result = apiHandler(db, '/api/recent') as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('/api/rules returns empty array on empty DB without crashing (regression for 0.2.2)', () => {
    const result = apiHandler(db, '/api/rules') as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('ensureSchema is idempotent — calling twice does not throw', () => {
    expect(() => {
      ensureSchema(db);
      ensureSchema(db);
    }).not.toThrow();
  });
});
