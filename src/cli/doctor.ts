#!/usr/bin/env node
/**
 * conduit-doctor — diagnostic checklist for a claude-conduit install.
 *
 * Checks, in order:
 *   1. DB file exists and is writable.
 *   2. ANTHROPIC_API_KEY env-var is set (warning, not fatal).
 *   3. Nearest .mcp.json contains a conduit entry.
 *   4. Node runtime >= 20.
 *   5. better-sqlite3 native binding loads and can open :memory:.
 *
 * Exit codes: 0 = all checks pass, 1 = at least one fail.
 * Warnings (API key, missing .mcp.json) do not fail the run.
 */
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  closeSync,
  openSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveDbPath } from '../db-path.js';

type Status = 'ok' | 'fail' | 'warn';

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
}

const HELP = `conduit-doctor — diagnose a claude-conduit install.

Usage:
  conduit-doctor [--help]

Exits 0 if all checks pass, 1 otherwise.
`;

function checkDatabase(): CheckResult {
  const path = resolveDbPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    return { name: 'database', status: 'fail', detail: `cannot create dir: ${String(e)}` };
  }
  try {
    if (existsSync(path)) {
      accessSync(path, constants.R_OK | constants.W_OK);
      const size = statSync(path).size;
      return { name: 'database', status: 'ok', detail: `${path} (${size} bytes)` };
    }
    // File does not exist — try to create it to prove we have write access.
    const fd = openSync(path, 'a');
    closeSync(fd);
    return { name: 'database', status: 'ok', detail: `${path} (created)` };
  } catch (e) {
    return { name: 'database', status: 'fail', detail: `not writable: ${String(e)}` };
  }
}

function checkApiKey(): CheckResult {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (key && key.length > 0) {
    return { name: 'anthropic api key', status: 'ok', detail: 'ANTHROPIC_API_KEY set' };
  }
  return {
    name: 'anthropic api key',
    status: 'warn',
    detail: 'ANTHROPIC_API_KEY not set — L3 compression will be disabled',
  };
}

function findMcpJsonUpwards(startDir: string): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i < 40; i++) {
    const candidate = join(dir, '.mcp.json');
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function checkMcpJson(): CheckResult {
  const path = findMcpJsonUpwards(process.cwd());
  if (!path) {
    return {
      name: '.mcp.json',
      status: 'warn',
      detail: 'no .mcp.json found walking up from cwd',
    };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const servers = parsed.mcpServers ?? {};
    if (servers['conduit']) {
      return { name: '.mcp.json', status: 'ok', detail: `${path} contains conduit entry` };
    }
    return {
      name: '.mcp.json',
      status: 'warn',
      detail: `${path} has no conduit entry — run conduit-init`,
    };
  } catch (e) {
    return { name: '.mcp.json', status: 'fail', detail: `cannot read/parse: ${String(e)}` };
  }
}

function checkNodeVersion(): CheckResult {
  const v = process.versions.node;
  const major = parseInt(v.split('.')[0] ?? '0', 10);
  if (major >= 20) return { name: 'node version', status: 'ok', detail: `v${v}` };
  return { name: 'node version', status: 'fail', detail: `v${v} — need >= 20` };
}

async function checkSqliteBinding(): Promise<CheckResult> {
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default;
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
    const row = db.prepare('SELECT x FROM t').get() as { x: number } | undefined;
    db.close();
    if (row?.x === 1) {
      return { name: 'better-sqlite3', status: 'ok', detail: 'native binding loads and works' };
    }
    return { name: 'better-sqlite3', status: 'fail', detail: 'unexpected query result' };
  } catch (e) {
    return { name: 'better-sqlite3', status: 'fail', detail: String(e) };
  }
}

function formatLine(r: CheckResult): string {
  const tag = r.status === 'ok' ? '[ok]  ' : r.status === 'warn' ? '[warn]' : '[fail]';
  return `${tag} ${r.name.padEnd(22)} ${r.detail}`;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  console.log('conduit doctor');
  console.log('');

  const results: CheckResult[] = [];
  results.push(checkDatabase());
  results.push(checkApiKey());
  results.push(checkMcpJson());
  results.push(checkNodeVersion());
  results.push(await checkSqliteBinding());

  for (const r of results) console.log(formatLine(r));

  const hasFail = results.some((r) => r.status === 'fail');
  console.log('');
  if (hasFail) {
    console.log('One or more checks failed. See detail above.');
    process.exit(1);
  }
  console.log('All required checks passed.');
  process.exit(0);
}

void main();
