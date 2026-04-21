#!/usr/bin/env node
/**
 * conduit-init — one-shot setup for claude-conduit.
 *
 * 1. Ensure ~/.claude-conduit/ exists and create an empty sessions.db
 *    (schema is initialised via ObservabilityBus).
 * 2. Walk upwards from cwd to find the nearest .mcp.json. Offer to add a
 *    conduit block. With --yes, add it without prompting. If no file is
 *    found, print a paste-ready block.
 * 3. Print next steps.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ObservabilityBus } from '../l6-observability.js';
import { resolveDbPath, defaultConduitDir } from '../db-path.js';

interface McpServersFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

const HELP = `conduit-init — set up claude-conduit for this machine.

Usage:
  conduit-init [--yes] [--help]

Options:
  --yes, -y    Automatically add the conduit block to .mcp.json if found.
  --help, -h   Show this help.

What it does:
  1. Creates ~/.claude-conduit/ and an empty sessions.db.
  2. Looks for the nearest .mcp.json walking up from the current directory.
  3. Adds a conduit entry (or prints one you can paste manually).
`;

function parseArgs(argv: string[]): { yes: boolean; help: boolean } {
  const flags = { yes: false, help: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--help' || a === '-h') flags.help = true;
  }
  return flags;
}

function findMcpJsonUpwards(startDir: string): string | null {
  let dir = resolve(startDir);
  // Guard against infinite loops on misconfigured FS.
  for (let i = 0; i < 40; i++) {
    const candidate = join(dir, '.mcp.json');
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function conduitBlock(): Record<string, unknown> {
  return {
    command: 'npx',
    args: ['-y', '@patchwindow/claude-conduit'],
    env: {
      // Leave empty; resolveDbPath() defaults to ~/.claude-conduit/sessions.db.
      // Users can set CONDUIT_DB_PATH here to override.
    },
  };
}

function printPasteBlock(): void {
  const example = {
    mcpServers: {
      conduit: conduitBlock(),
    },
  };
  console.log('No .mcp.json found in this directory or any parent.');
  console.log('Paste the following into your .mcp.json:');
  console.log('');
  console.log(JSON.stringify(example, null, 2));
}

function addToMcpJson(path: string, yes: boolean): boolean {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    console.error(`Could not read ${path}: ${String(e)}`);
    return false;
  }

  let parsed: McpServersFile;
  try {
    parsed = JSON.parse(raw) as McpServersFile;
  } catch (e) {
    console.error(`Could not parse ${path} as JSON: ${String(e)}`);
    return false;
  }

  parsed.mcpServers ??= {};
  if (parsed.mcpServers['conduit']) {
    console.log(`[ok] conduit already present in ${path}`);
    return true;
  }

  if (!yes) {
    console.log(`Found ${path}.`);
    console.log('Re-run with --yes to append this block automatically:');
    console.log('');
    console.log(JSON.stringify({ conduit: conduitBlock() }, null, 2));
    return true;
  }

  parsed.mcpServers['conduit'] = conduitBlock();
  writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  console.log(`[ok] added conduit block to ${path}`);
  return true;
}

function initDatabase(): string {
  const dbPath = resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  // Touch the file via ObservabilityBus so schema is initialised.
  const obs = new ObservabilityBus(dbPath);
  obs.close();
  return dbPath;
}

function main(): void {
  const argv = process.argv.slice(2);
  const { yes, help } = parseArgs(argv);
  if (help) {
    console.log(HELP);
    process.exit(0);
  }

  console.log('conduit init — setting up claude-conduit');
  console.log('');

  // 1. DB + folder
  const dbPath = initDatabase();
  console.log(`[ok] data folder ready: ${defaultConduitDir()}`);
  console.log(`[ok] sessions.db created: ${dbPath}`);

  // 2. .mcp.json discovery
  const mcpPath = findMcpJsonUpwards(process.cwd());
  if (mcpPath) {
    addToMcpJson(mcpPath, yes);
  } else {
    printPasteBlock();
  }

  // 3. Next steps
  console.log('');
  console.log('Next steps:');
  console.log('  - Set ANTHROPIC_API_KEY if you want L3 compression (conduit_compress).');
  console.log('  - Restart your Claude Code session to pick up the MCP server.');
  console.log('  - Run `conduit doctor` to verify the setup.');
  process.exit(0);
}

main();
