#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { LazyToolRegistry } from './l1-tool-registry.js';
import { SemanticDeduplicator } from './l2-deduplication.js';
import { ContextCompressor } from './l3-compressor.js';
import { CacheOrchestrator } from './l4-cache-orchestrator.js';
import { ObservabilityBus } from './l6-observability.js';
import { AgentHandoffCompressor } from './l7-handoff.js';
import { FeedbackLoop } from './l8-feedback.js';
import { ModelRouter } from './l5-router.js';
import { ABTesting } from './l5-ab-testing.js';
import { resolveDbPath } from './db-path.js';
import { ensureSchema } from './db-schema.js';
import { registerAllTools } from './tool-definitions.js';

const registry = new LazyToolRegistry();
const deduplicator = new SemanticDeduplicator();
const compressor = new ContextCompressor();
const cacheOrchestrator = new CacheOrchestrator();
const obs = new ObservabilityBus(resolveDbPath());
// Säkerställ att alla tabeller finns direkt när servern startar, så att
// dashbord-klienter kan öppna samma DB-fil utan att vara beroende av att
// ett specifikt MCP-tool har körts först. Idempotent.
ensureSchema(obs.getDb());
const handoff = new AgentHandoffCompressor();
const feedback = new FeedbackLoop(obs.getDb());
const router = new ModelRouter();
const ab = new ABTesting(obs.getDb());

// Auto-reporting: starta en ny session märkt med agent-namnet från
// miljön (default "unknown") så varje conduit_*-anrop kan lindas med
// `withReporting` och automatiskt loggas till L6. Dashboarden lyser upp
// utan att man behöver kalla `conduit_report` explicit.
const AGENT_NAME = process.env['CONDUIT_AGENT_NAME'] ?? 'unknown';
const SESSION_ID = obs.startSession(AGENT_NAME, 'mcp-server');

const server = new McpServer({
  name: 'claude-conduit',
  version: '0.4.0',
});

// Tool-ytan bor i `tool-definitions.ts` — en ren modul som kan inspekteras
// från tester utan att starta en MCP-transport. Här registrerar vi alla
// tools (canonical + backwards-compatible aliases) mot den faktiska
// servern. Se `tool-definitions.ts` för renaming-karta och deprecation-
// markeringar.
registerAllTools(server, {
  registry,
  deduplicator,
  compressor,
  cacheOrchestrator,
  obs,
  handoff,
  feedback,
  router,
  ab,
  sessionId: SESSION_ID,
});

const transport = new StdioServerTransport();
await server.connect(transport);
