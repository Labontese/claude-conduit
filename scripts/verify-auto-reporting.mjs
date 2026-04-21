#!/usr/bin/env node
/**
 * Live-verifiering av 0.3.0 auto-reporting.
 *
 * Startar L6 mot en temporär fil-DB, lindar ett par dummy-handlers med
 * `withReporting` och kör anrop. Öppnar sedan DB:n separat (som dashboarden
 * gör) och räknar rader.
 *
 * Kör:  node scripts/verify-auto-reporting.mjs
 */
import { ObservabilityBus } from '../dist/l6-observability.js';
import { withReporting } from '../dist/reporting-middleware.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'conduit-verify-'));
const dbPath = join(dir, 'sessions.db');

console.log(`DB-fil: ${dbPath}\n`);

const obs = new ObservabilityBus(dbPath);
const sessionId = obs.startSession('saga-verify', 'mcp-server');

const env = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

const searchHandler = withReporting('conduit_search_tools', obs, sessionId, async () =>
  env([{ name: 'read_file', description: 'Read a file' }]),
);
const dedupHandler = withReporting('conduit_deduplicate', obs, sessionId, async () =>
  env({
    messages: [],
    stats: { blocks_total: 5, blocks_deduplicated: 2, tokens_saved_estimate: 240, strategy_used: 'exact' },
  }),
);
const handoffHandler = withReporting('conduit_handoff', obs, sessionId, async () =>
  env({ contract: { raw_tokens: 5000, compressed_tokens: 600 }, system_prompt: '...' }),
);

await searchHandler({ query: 'file' });
await dedupHandler({ messages: [] });
await handoffHandler({ from_agent: 'Anna', to_agent: 'Stella' });

obs.close();

// Öppna DB:n separat — simulera dashboard-klient
const db = new Database(dbPath, { readonly: true });
const sessions = db.prepare('SELECT COUNT(*) as n FROM sessions').get().n;
const requests = db.prepare('SELECT COUNT(*) as n FROM requests').get().n;
const rows = db
  .prepare('SELECT tool_name, input_tokens, saved_tokens, latency_ms FROM requests ORDER BY ts')
  .all();
const report = db
  .prepare(
    `SELECT COUNT(*) as requests,
            COALESCE(SUM(saved_tokens),0) as saved_tokens,
            COALESCE(SUM(input_tokens),0) as input_tokens
     FROM requests`,
  )
  .get();

console.log(`sessions.db räkning:`);
console.log(`  sessions: ${sessions}`);
console.log(`  requests: ${requests}`);
console.log(`  SUM(saved_tokens): ${report.saved_tokens}`);
console.log(`  SUM(input_tokens): ${report.input_tokens}`);
console.log(`\nRader per tool:`);
for (const r of rows) {
  console.log(
    `  ${r.tool_name.padEnd(25)} input=${String(r.input_tokens).padStart(5)} saved=${String(r.saved_tokens ?? 0).padStart(5)} latency=${r.latency_ms}ms`,
  );
}

db.close();
rmSync(dir, { recursive: true, force: true });

// Assertion-liknande check
if (sessions >= 1 && requests === 3) {
  console.log(`\n✓ OK — ${sessions} session(s), ${requests} requests (förväntat >=1 session, 3 requests)`);
  process.exit(0);
} else {
  console.error(`\n✗ FAIL — förväntat >=1 session och 3 requests, fick ${sessions} och ${requests}`);
  process.exit(1);
}
