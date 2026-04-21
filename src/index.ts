#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LazyToolRegistry } from './l1-tool-registry.js';
import { SemanticDeduplicator } from './l2-deduplication.js';
import { ContextCompressor } from './l3-compressor.js';
import { CacheOrchestrator, type AnthropicRequest } from './l4-cache-orchestrator.js';
import { ObservabilityBus } from './l6-observability.js';
import { AgentHandoffCompressor } from './l7-handoff.js';
import { FeedbackLoop } from './l8-feedback.js';
import { ModelRouter } from './l5-router.js';
import { ABTesting } from './l5-ab-testing.js';

const registry = new LazyToolRegistry();
const deduplicator = new SemanticDeduplicator();
const compressor = new ContextCompressor();
const cacheOrchestrator = new CacheOrchestrator();
const obs = new ObservabilityBus(process.env['CONDUIT_DB_PATH'] ?? ':memory:');
const handoff = new AgentHandoffCompressor();
const feedback = new FeedbackLoop(obs.getDb());
const router = new ModelRouter();
const ab = new ABTesting(obs.getDb());

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

server.tool(
  'conduit_deduplicate',
  'Remove duplicate or near-duplicate messages from a conversation. Returns deduplicated messages + stats.',
  {
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })).describe('Conversation messages to deduplicate'),
    threshold: z.number().min(0).max(1).optional().describe('Similarity threshold 0-1 (default 0.97)'),
  },
  async ({ messages, threshold }) => {
    const result = deduplicator.deduplicateMessages(messages, threshold ?? 0.97);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'conduit_compress',
  'Compress long conversation history using Haiku summarization. Preserves decisions, code, and key facts.',
  {
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })).describe('Conversation messages to compress'),
    trigger_tokens: z.number().optional().describe('Token threshold to trigger compression (default 8000)'),
    keep_recent_turns: z.number().optional().describe('Number of recent turns to keep verbatim (default 4)'),
  },
  async ({ messages, trigger_tokens, keep_recent_turns }) => {
    const result = await compressor.compress(messages, {
      triggerTokens: trigger_tokens ?? 8000,
      keepRecentTurns: keep_recent_turns ?? 4,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'conduit_handoff',
  'Compress current conversation into a structured handoff contract for the next agent. Returns a compact system prompt.',
  {
    from_agent: z.string().describe('Name of the current agent'),
    to_agent: z.string().describe('Name of the receiving agent'),
    task: z.string().describe('One sentence: what needs to be done'),
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })).describe('Conversation history to compress'),
    context_hint: z.string().optional().describe('Extra context hint for the compressor'),
  },
  async ({ from_agent, to_agent, task, messages, context_hint }) => {
    const result = await handoff.compress({ from_agent, to_agent, task, messages, context_hint });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'conduit_fetch_handoff',
  'Retrieve the full handoff contract by ID.',
  { handoff_id: z.string().describe('Handoff contract ID from conduit_handoff') },
  async ({ handoff_id }) => {
    const contract = handoff.fetch(handoff_id);
    if (!contract) {
      return { content: [{ type: 'text', text: `Handoff not found: ${handoff_id}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(contract, null, 2) }] };
  },
);

server.tool(
  'conduit_feedback',
  'Report quality feedback on a request. Used to track which optimizations help or hurt.',
  {
    request_id: z.string().describe('Request ID to rate'),
    rating: z.enum(['good', 'bad', 'partial']).describe('Quality rating'),
    rule_suspected: z.string().optional().describe('Optimization rule suspected of causing issue'),
    notes: z.string().optional().describe('Free-text notes'),
  },
  async ({ request_id, rating, rule_suspected, notes }) => {
    feedback.recordFeedback({ request_id, rating, rule_suspected, notes });
    return { content: [{ type: 'text', text: feedback.formatRuleReport() }] };
  },
);

server.tool(
  'conduit_rule_stats',
  'Show optimization rule statistics and auto-disabled rules.',
  { format: z.enum(['json', 'markdown']).optional().default('markdown') },
  async ({ format }) => {
    const text = format === 'markdown'
      ? feedback.formatRuleReport()
      : JSON.stringify(feedback.getAllRuleStats(), null, 2);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'conduit_route_model',
  'Suggest the cheapest capable model for a given prompt. Returns model ID, tier, and reasoning.',
  {
    prompt: z.string().describe('The prompt or task description to route'),
    policy: z.enum(['aggressive', 'conservative', 'off']).optional().default('conservative'),
    force_model: z.string().optional().describe('Override routing with a specific model ID'),
  },
  async ({ prompt, policy, force_model }) => {
    const decision = router.route(prompt, policy, force_model);
    return { content: [{ type: 'text', text: JSON.stringify(decision, null, 2) }] };
  },
);

server.tool(
  'conduit_ab_create',
  'Create an A/B experiment with two instruction variants.',
  {
    name: z.string().describe('Experiment name (unique)'),
    variants: z.array(z.object({
      name: z.string(),
      instruction: z.string(),
    })).min(2).describe('At least 2 variants with name and instruction'),
  },
  async ({ name, variants }) => {
    const exp = ab.createExperiment(name, variants);
    return { content: [{ type: 'text', text: JSON.stringify(exp, null, 2) }] };
  },
);

server.tool(
  'conduit_ab_assign',
  'Get the assigned instruction variant for this session.',
  {
    session_id: z.string().describe('Current session ID'),
    experiment_name: z.string().describe('Experiment to assign'),
  },
  async ({ session_id, experiment_name }) => {
    const assignment = ab.assign(session_id, experiment_name);
    if (!assignment) {
      return { content: [{ type: 'text', text: `Experiment not found: ${experiment_name}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(assignment, null, 2) }] };
  },
);

server.tool(
  'conduit_ab_list',
  'List all A/B experiments.',
  {},
  async () => {
    const experiments = ab.listExperiments();
    return { content: [{ type: 'text', text: JSON.stringify(experiments, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
