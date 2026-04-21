#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LazyToolRegistry } from './l1-tool-registry.js';
import { CacheOrchestrator, type AnthropicRequest } from './l4-cache-orchestrator.js';
import { ObservabilityBus } from './l6-observability.js';

const registry = new LazyToolRegistry();
const cacheOrchestrator = new CacheOrchestrator();
const obs = new ObservabilityBus(process.env['CONDUIT_DB_PATH'] ?? ':memory:');

const server = new McpServer({
  name: 'claude-conduit',
  version: '0.1.0',
});

server.tool(
  'conduit_search_tools',
  'Search registered tools by intent. Returns name and description only — no schemas.',
  {
    query: z.string().describe('Search query'),
    max_results: z.number().optional().describe('Max results (default 5)'),
  },
  async ({ query, max_results }) => {
    const results = registry.searchTools(query, max_results ?? 5);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

server.tool(
  'conduit_describe_tool',
  'Get full schema for a specific tool by name.',
  { name: z.string().describe('Tool name') },
  async ({ name }) => {
    const tool = registry.describeTool(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Tool not found: ${name}` }], isError: true };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'conduit_execute_tool',
  'Execute a registered tool by name with given arguments.',
  {
    name: z.string().describe('Tool name'),
    args: z.record(z.string(), z.unknown()).optional().describe('Tool arguments'),
  },
  async ({ name, args }) => {
    try {
      const result = await registry.executeTool(name, args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: String(e) }], isError: true };
    }
  },
);

server.tool(
  'conduit_wrap_request',
  'Optimize an Anthropic API request with cache breakpoints. Returns optimized request + token savings metadata.',
  {
    request: z.record(z.string(), z.unknown()).describe('Full Anthropic Messages API request object'),
    session_id: z.string().optional(),
    agent_name: z.string().optional(),
    disable: z
      .array(z.string())
      .optional()
      .describe('Optimizations to skip: cache_tools|cache_system|cache_messages'),
  },
  async ({ request, disable }) => {
    const wrapped = cacheOrchestrator.wrapRequest(request as unknown as AnthropicRequest, disable);
    return { content: [{ type: 'text', text: JSON.stringify(wrapped, null, 2) }] };
  },
);

server.tool(
  'conduit_report',
  'Get token usage and cost report for current session.',
  {
    session_id: z.string().optional(),
    format: z.enum(['json', 'markdown']).optional().default('markdown'),
  },
  async ({ session_id, format }) => {
    const report = obs.getSessionReport(session_id);
    const text =
      format === 'markdown' ? obs.formatReport(report) : JSON.stringify(report, null, 2);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'conduit_explain',
  'Human-readable explanation of what conduit optimized this session.',
  { request_id: z.string().optional() },
  async () => {
    const report = obs.getSessionReport();
    const totalRaw = report.totalInputTokens + report.totalSavedTokens;
    const pct = totalRaw > 0 ? ((report.totalSavedTokens / totalRaw) * 100).toFixed(1) : '0';
    return {
      content: [
        {
          type: 'text',
          text:
            `conduit has processed ${report.requestCount} request(s) this session.\n` +
            `Cache hit rate: ${(report.avgCacheHitRate * 100).toFixed(1)}%\n` +
            `Estimated token reduction: ${pct}%\n` +
            `Estimated cost saved: $${(report.totalBaselineCostUsd - report.totalCostUsd).toFixed(4)}`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
