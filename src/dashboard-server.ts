#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { resolveDbPath } from './db-path.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  // No readonly flag: better-sqlite3 needs write access to auto-create the
  // file on first open. Dashboard handlers only issue SELECTs, so this is
  // safe in practice.
  return new Database(dbPath);
}

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

export function startDashboard(dbPath: string, port = 4747): void {
  const db = getDb(dbPath);
  const htmlPath = join(__dirname, '..', 'dashboard', 'index.html');

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (url.pathname.startsWith('/api/')) {
      const data = apiHandler(db, url.pathname);
      if (!data) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
      return;
    }

    // Serve dashboard HTML
    try {
      const html = readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('Dashboard not found — run npm run build first');
    }
  });

  server.listen(port, () => {
    console.log(`conduit dashboard → http://localhost:${port}`);
  });
}

// CLI entry: node dist/dashboard-server.js [db-path] [port]
const args = process.argv.slice(2);
const dbPath = args[0] ?? resolveDbPath();
const port = parseInt(args[1] ?? '4747', 10);
startDashboard(dbPath, port);
