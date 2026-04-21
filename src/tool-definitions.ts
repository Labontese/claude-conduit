/**
 * Central tool-registrering för claude-conduit MCP-server.
 *
 * Bakgrund (Nova 2026-04-21): Annas UX-audit identifierade att flera
 * tool-namn läcker intern L1–L8-arkitektur. Fas 1 döper om tio tools
 * till uppgifts-orienterade namn och förenklar input-schemas.
 *
 * Backwards compatibility: gamla namn fortsätter fungera som aliases
 * (identisk handler, oförändrad semantik). Deprecation markeras i
 * description-texten — MCP-protokollet har inget dedikerat flagg-fält.
 *
 * Testbarhet: `buildToolSurface(deps)` returnerar en ren lista av
 * tool-definitioner utan att kalla `server.tool()`. Det låter tester
 * verifiera namn, aliases och schemas utan att starta en MCP-transport.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { LazyToolRegistry } from './l1-tool-registry.js';
import type { SemanticDeduplicator } from './l2-deduplication.js';
import type { ContextCompressor } from './l3-compressor.js';
import type { CacheOrchestrator, AnthropicRequest } from './l4-cache-orchestrator.js';
import type { ObservabilityBus } from './l6-observability.js';
import type { AgentHandoffCompressor } from './l7-handoff.js';
import type { FeedbackLoop } from './l8-feedback.js';
import type { ModelRouter } from './l5-router.js';
import type { ABTesting } from './l5-ab-testing.js';

import { withReporting } from './reporting-middleware.js';
import {
  normaliseMessages,
  resolveCompressOptions,
  type MessageInput,
} from './input-adapters.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ConduitDeps {
  registry: LazyToolRegistry;
  deduplicator: SemanticDeduplicator;
  compressor: ContextCompressor;
  cacheOrchestrator: CacheOrchestrator;
  obs: ObservabilityBus;
  handoff: AgentHandoffCompressor;
  feedback: FeedbackLoop;
  router: ModelRouter;
  ab: ABTesting;
  sessionId: string;
}

type McpHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ToolSurfaceEntry {
  name: string;
  description: string;
  /** True if this entry is a deprecated alias of another canonical name. */
  deprecated: boolean;
  /** Canonical name this alias points to (same as `name` for canonical entries). */
  canonical: string;
  /** Zod shape passed to `server.tool()` — used by tests to inspect schema. */
  schema: Record<string, z.ZodTypeAny>;
  /** Handler that executes the tool — pre-wrapped with auto-reporting. */
  handler: McpHandler;
}

// ---------------------------------------------------------------------------
// Schemas (Zod shapes used by both canonical tools and aliases)
// ---------------------------------------------------------------------------

const messageObjectSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

// Items-schema accepterar båda formerna. Vi kan inte använda z.union med
// två arrays på översta nivån (MCP-serialiseringen gillar inte det), så
// vi tar en array av `string | {role,content}` — vilket i praktiken
// tillåter en homogen lista av endera typen.
const messageItemsSchema = z
  .array(z.union([z.string(), messageObjectSchema]))
  .describe('List of messages — strings (treated as role="user") or {role, content} objects');

// ---------------------------------------------------------------------------
// Helper: bygga en (canonical, alias[]) grupp med delad handler
// ---------------------------------------------------------------------------

function group(
  canonical: { name: string; description: string; schema: Record<string, z.ZodTypeAny>; handler: McpHandler },
  aliases: Array<{ name: string; description?: string }> = [],
): ToolSurfaceEntry[] {
  const entries: ToolSurfaceEntry[] = [
    {
      name: canonical.name,
      description: canonical.description,
      deprecated: false,
      canonical: canonical.name,
      schema: canonical.schema,
      handler: canonical.handler,
    },
  ];
  for (const alias of aliases) {
    entries.push({
      name: alias.name,
      description:
        alias.description ??
        `[DEPRECATED — use ${canonical.name}] ${canonical.description}`,
      deprecated: true,
      canonical: canonical.name,
      schema: canonical.schema,
      handler: canonical.handler,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Build the full tool surface — pure function, no side effects
// ---------------------------------------------------------------------------

export function buildToolSurface(deps: ConduitDeps): ToolSurfaceEntry[] {
  const { registry, deduplicator, compressor, cacheOrchestrator, obs, handoff, feedback, router, ab, sessionId } =
    deps;

  const entries: ToolSurfaceEntry[] = [];

  // -------------------------------------------------------------------------
  // L1 — Tool registry (infrastruktur, inga omdöpningar utöver execute → call)
  // -------------------------------------------------------------------------

  entries.push(
    ...group({
      name: 'conduit_search_tools',
      description: 'Search registered tools by intent. Returns name and description only — no schemas.',
      schema: {
        query: z.string().describe('Search query'),
        max_results: z.number().optional().describe('Max results (default 5)'),
      },
      handler: withReporting('conduit_search_tools', obs, sessionId, async (args: Record<string, unknown>) => {
        const { query, max_results } = args as { query: string; max_results?: number };
        const results = registry.searchTools(query, max_results ?? 5);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      }) as McpHandler,
    }),
  );

  entries.push(
    ...group({
      name: 'conduit_describe_tool',
      description: 'Get full schema for a specific tool by name.',
      schema: { name: z.string().describe('Tool name') },
      handler: withReporting('conduit_describe_tool', obs, sessionId, async (args: Record<string, unknown>) => {
        const { name } = args as { name: string };
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
      }) as McpHandler,
    }),
  );

  entries.push(
    ...group(
      {
        name: 'conduit_call_tool',
        description: 'Execute a registered tool by name with given arguments (MCP-convention name).',
        schema: {
          name: z.string().describe('Tool name'),
          args: z.record(z.string(), z.unknown()).optional().describe('Tool arguments'),
        },
        handler: withReporting('conduit_call_tool', obs, sessionId, async (args: Record<string, unknown>) => {
          const { name, args: toolArgs } = args as { name: string; args?: Record<string, unknown> };
          try {
            const result = await registry.executeTool(name, toolArgs ?? {});
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          } catch (e) {
            return { content: [{ type: 'text', text: String(e) }], isError: true };
          }
        }) as McpHandler,
      },
      [{ name: 'conduit_execute_tool' }],
    ),
  );

  // -------------------------------------------------------------------------
  // L4 — Cache orchestrator: conduit_wrap_request → conduit_optimize_request
  // Acceptera också "minimal" form med bara {model, messages}
  // -------------------------------------------------------------------------

  entries.push(
    ...group(
      {
        name: 'conduit_optimize_request',
        description:
          'Optimize an Anthropic API request with cache breakpoints. Accepts either a full Messages request or a minimal {model, messages} form. Returns optimized request + token savings metadata.',
        schema: {
          request: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Full Anthropic Messages API request object (preferred)'),
          model: z.string().optional().describe('Model ID — used with `messages` for minimal form'),
          messages: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe('Messages — used with `model` for minimal form'),
          session_id: z.string().optional(),
          agent_name: z.string().optional(),
          disable: z
            .array(z.string())
            .optional()
            .describe('Optimizations to skip: cache_tools|cache_system|cache_messages'),
        },
        handler: withReporting(
          'conduit_optimize_request',
          obs,
          sessionId,
          async (args: Record<string, unknown>) => {
            const { request, model, messages, disable } = args as {
              request?: Record<string, unknown>;
              model?: string;
              messages?: Array<Record<string, unknown>>;
              disable?: string[];
            };

            let resolved: AnthropicRequest;
            if (request) {
              resolved = request as unknown as AnthropicRequest;
            } else if (model && messages) {
              resolved = {
                model,
                messages: messages as unknown as AnthropicRequest['messages'],
              };
            } else {
              return {
                content: [
                  {
                    type: 'text',
                    text:
                      'conduit_optimize_request requires either `request` (full object) or both `model` + `messages` (minimal form).',
                  },
                ],
                isError: true,
              };
            }

            const wrapped = cacheOrchestrator.wrapRequest(resolved, disable);
            return { content: [{ type: 'text', text: JSON.stringify(wrapped, null, 2) }] };
          },
        ) as McpHandler,
      },
      [{ name: 'conduit_wrap_request' }],
    ),
  );

  // -------------------------------------------------------------------------
  // L6 — Reports
  // -------------------------------------------------------------------------

  entries.push(
    ...group(
      {
        name: 'conduit_cost_report',
        description: 'Get token usage and cost report for current session.',
        schema: {
          session_id: z.string().optional(),
          format: z.enum(['json', 'markdown']).optional().default('markdown'),
        },
        handler: withReporting('conduit_cost_report', obs, sessionId, async (args: Record<string, unknown>) => {
          const { session_id, format } = args as {
            session_id?: string;
            format?: 'json' | 'markdown';
          };
          const report = obs.getSessionReport(session_id ?? sessionId);
          const text =
            (format ?? 'markdown') === 'markdown'
              ? obs.formatReport(report)
              : JSON.stringify(report, null, 2);
          return { content: [{ type: 'text', text }] };
        }) as McpHandler,
      },
      [{ name: 'conduit_report' }],
    ),
  );

  entries.push(
    ...group(
      {
        name: 'conduit_explain_request',
        description: 'Human-readable explanation of what conduit optimized this session.',
        schema: { request_id: z.string().optional() },
        handler: withReporting(
          'conduit_explain_request',
          obs,
          sessionId,
          async () => {
            const report = obs.getSessionReport(sessionId);
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
        ) as McpHandler,
      },
      [{ name: 'conduit_explain' }],
    ),
  );

  // -------------------------------------------------------------------------
  // L2 — Deduplication: conduit_deduplicate → conduit_dedupe
  // Ny input: items (string[] | {role,content}[]), case_sensitive, return
  //
  // Nota bene (Nova 2026-04-21, rev. efter Daniels godkännande): tidigare
  // version behöll `conduit_deduplicate` som separat handler för strict
  // BC. Daniel verifierade att ingen kod i Team Daniel eller conduit-
  // repot använder det gamla namnet, och att paketet är 1 dag gammalt
  // på npm. Alias-konsistens > strict BC. `conduit_deduplicate` delar
  // nu handler med `conduit_dedupe` — vilket innebär beteendeändring:
  // case-insensitive default och return=clean default.
  // -------------------------------------------------------------------------

  entries.push(
    ...group(
      {
        name: 'conduit_dedupe',
        description:
          'Remove duplicate or near-duplicate items from a list. Accepts strings or {role, content} objects. Case-insensitive by default. Returns deduplicated items + stats.',
        schema: {
          items: messageItemsSchema.optional().describe('Items to deduplicate (preferred input)'),
          messages: z
            .array(messageObjectSchema)
            .optional()
            .describe('Legacy alias for `items` (kept for backwards compatibility)'),
          threshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe('Similarity threshold 0-1 (default 0.97)'),
          case_sensitive: z
            .boolean()
            .optional()
            .describe('Exact-match mode (default false — lowercases + trims before hashing)'),
          return: z
            .enum(['clean', 'annotated'])
            .optional()
            .describe('"clean" (default) removes duplicates; "annotated" keeps them with [duplicate of: hash] markers'),
        },
        handler: withReporting('conduit_dedupe', obs, sessionId, async (args: Record<string, unknown>) => {
          const { items, messages, threshold, case_sensitive, return: returnMode } = args as {
            items?: MessageInput[];
            messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
            threshold?: number;
            case_sensitive?: boolean;
            return?: 'clean' | 'annotated';
          };
          const source: ReadonlyArray<MessageInput> = items ?? messages ?? [];
          const result = deduplicator.deduplicateItems(source, {
            threshold,
            case_sensitive,
            return: returnMode,
          });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }) as McpHandler,
      },
      [{ name: 'conduit_deduplicate' }],
    ),
  );

  // -------------------------------------------------------------------------
  // L3 — Compression: conduit_compress → conduit_summarize_history
  // Nya inputs: items (string[] | messages), preset: aggressive|balanced|light
  // -------------------------------------------------------------------------

  entries.push(
    ...group(
      {
        name: 'conduit_summarize_history',
        description:
          'Summarize a long conversation history via Haiku. Preserves decisions, code, and key facts. Accepts strings or {role, content} objects. Use `preset` for quick tuning.',
        schema: {
          items: messageItemsSchema.optional().describe('Conversation items to compress (preferred input)'),
          messages: z
            .array(messageObjectSchema)
            .optional()
            .describe('Legacy alias for `items` (kept for backwards compatibility)'),
          preset: z
            .enum(['aggressive', 'balanced', 'light'])
            .optional()
            .describe('Preset for trigger_tokens and keep_recent_turns (default "balanced")'),
          trigger_tokens: z
            .number()
            .optional()
            .describe('Explicit token threshold — overrides preset'),
          keep_recent_turns: z
            .number()
            .optional()
            .describe('Explicit recent-turn count — overrides preset'),
        },
        handler: withReporting(
          'conduit_summarize_history',
          obs,
          sessionId,
          async (args: Record<string, unknown>) => {
            const {
              items,
              messages,
              preset,
              trigger_tokens,
              keep_recent_turns,
            } = args as {
              items?: MessageInput[];
              messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
              preset?: 'aggressive' | 'balanced' | 'light';
              trigger_tokens?: number;
              keep_recent_turns?: number;
            };

            const source: ReadonlyArray<MessageInput> = items ?? messages ?? [];
            const normalised = normaliseMessages(source);
            const opts = resolveCompressOptions({ preset, trigger_tokens, keep_recent_turns });
            const result = await compressor.compress(normalised, {
              triggerTokens: opts.triggerTokens,
              keepRecentTurns: opts.keepRecentTurns,
            });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          },
        ) as McpHandler,
      },
      [{ name: 'conduit_compress' }],
    ),
  );

  // -------------------------------------------------------------------------
  // L7 — Handoff: conduit_handoff → conduit_handoff_pack
  //                conduit_fetch_handoff → conduit_handoff_load
  // Nya inputs: from_agent/to_agent valfria, messages: string[] ok
  // -------------------------------------------------------------------------

  entries.push(
    ...group(
      {
        name: 'conduit_handoff_pack',
        description:
          'Compress current conversation into a structured handoff contract for the next agent. `from_agent` and `to_agent` are optional metadata. Accepts strings or {role, content} objects.',
        schema: {
          task: z.string().describe('One sentence: what needs to be done'),
          messages: messageItemsSchema.describe('Conversation history to compress'),
          from_agent: z.string().optional().describe('Name of the current agent (metadata — optional)'),
          to_agent: z.string().optional().describe('Name of the receiving agent (metadata — optional)'),
          context_hint: z.string().optional().describe('Extra context hint for the compressor'),
        },
        handler: withReporting(
          'conduit_handoff_pack',
          obs,
          sessionId,
          async (args: Record<string, unknown>) => {
            const { from_agent, to_agent, task, messages, context_hint } = args as {
              from_agent?: string;
              to_agent?: string;
              task: string;
              messages: MessageInput[];
              context_hint?: string;
            };
            const normalised = normaliseMessages(messages);
            const result = await handoff.compress({
              from_agent: from_agent ?? 'unknown',
              to_agent: to_agent ?? 'unknown',
              task,
              messages: normalised,
              context_hint,
            });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          },
        ) as McpHandler,
      },
      [{ name: 'conduit_handoff' }],
    ),
  );

  entries.push(
    ...group(
      {
        name: 'conduit_handoff_load',
        description: 'Retrieve the full handoff contract by ID.',
        schema: { handoff_id: z.string().describe('Handoff contract ID from conduit_handoff_pack') },
        handler: withReporting(
          'conduit_handoff_load',
          obs,
          sessionId,
          async (args: Record<string, unknown>) => {
            const { handoff_id } = args as { handoff_id: string };
            const contract = handoff.fetch(handoff_id);
            if (!contract) {
              return {
                content: [{ type: 'text', text: `Handoff not found: ${handoff_id}` }],
                isError: true,
              };
            }
            return { content: [{ type: 'text', text: JSON.stringify(contract, null, 2) }] };
          },
        ) as McpHandler,
      },
      [{ name: 'conduit_fetch_handoff' }],
    ),
  );

  // -------------------------------------------------------------------------
  // L8 — Feedback + rule stats: conduit_rule_stats → conduit_optimization_stats
  // -------------------------------------------------------------------------

  entries.push(
    ...group({
      name: 'conduit_feedback',
      description: 'Report quality feedback on a request. Used to track which optimizations help or hurt.',
      schema: {
        request_id: z.string().describe('Request ID to rate'),
        rating: z.enum(['good', 'bad', 'partial']).describe('Quality rating'),
        rule_suspected: z.string().optional().describe('Optimization rule suspected of causing issue'),
        notes: z.string().optional().describe('Free-text notes'),
      },
      handler: withReporting('conduit_feedback', obs, sessionId, async (args: Record<string, unknown>) => {
        const { request_id, rating, rule_suspected, notes } = args as {
          request_id: string;
          rating: 'good' | 'bad' | 'partial';
          rule_suspected?: string;
          notes?: string;
        };
        feedback.recordFeedback({ request_id, rating, rule_suspected, notes });
        return { content: [{ type: 'text', text: feedback.formatRuleReport() }] };
      }) as McpHandler,
    }),
  );

  entries.push(
    ...group(
      {
        name: 'conduit_optimization_stats',
        description: 'Show optimization rule statistics and auto-disabled rules.',
        schema: { format: z.enum(['json', 'markdown']).optional().default('markdown') },
        handler: withReporting(
          'conduit_optimization_stats',
          obs,
          sessionId,
          async (args: Record<string, unknown>) => {
            const { format } = args as { format?: 'json' | 'markdown' };
            const text =
              (format ?? 'markdown') === 'markdown'
                ? feedback.formatRuleReport()
                : JSON.stringify(feedback.getAllRuleStats(), null, 2);
            return { content: [{ type: 'text', text }] };
          },
        ) as McpHandler,
      },
      [{ name: 'conduit_rule_stats' }],
    ),
  );

  // -------------------------------------------------------------------------
  // L5 — Router + A/B testing
  // conduit_route_model behålls (bästa namnet i klassen enligt Anna)
  // conduit_ab_assign → conduit_ab_get_variant
  // -------------------------------------------------------------------------

  entries.push(
    ...group({
      name: 'conduit_route_model',
      description: 'Suggest the cheapest capable model for a given prompt. Returns model ID, tier, and reasoning.',
      schema: {
        prompt: z.string().describe('The prompt or task description to route'),
        policy: z.enum(['aggressive', 'conservative', 'off']).optional().default('conservative'),
        force_model: z.string().optional().describe('Override routing with a specific model ID'),
      },
      handler: withReporting('conduit_route_model', obs, sessionId, async (args: Record<string, unknown>) => {
        const { prompt, policy, force_model } = args as {
          prompt: string;
          policy?: 'aggressive' | 'conservative' | 'off';
          force_model?: string;
        };
        const decision = router.route(prompt, policy ?? 'conservative', force_model);
        return { content: [{ type: 'text', text: JSON.stringify(decision, null, 2) }] };
      }) as McpHandler,
    }),
  );

  entries.push(
    ...group({
      name: 'conduit_ab_create',
      description: 'Create an A/B experiment with two instruction variants.',
      schema: {
        name: z.string().describe('Experiment name (unique)'),
        variants: z
          .array(z.object({ name: z.string(), instruction: z.string() }))
          .min(2)
          .describe('At least 2 variants with name and instruction'),
      },
      handler: withReporting('conduit_ab_create', obs, sessionId, async (args: Record<string, unknown>) => {
        const { name, variants } = args as {
          name: string;
          variants: Array<{ name: string; instruction: string }>;
        };
        const exp = ab.createExperiment(name, variants);
        return { content: [{ type: 'text', text: JSON.stringify(exp, null, 2) }] };
      }) as McpHandler,
    }),
  );

  entries.push(
    ...group(
      {
        name: 'conduit_ab_get_variant',
        description: 'Get the assigned instruction variant for this session (sticky per session_id).',
        schema: {
          session_id: z.string().describe('Current session ID'),
          experiment_name: z.string().describe('Experiment to assign'),
        },
        handler: withReporting(
          'conduit_ab_get_variant',
          obs,
          sessionId,
          async (args: Record<string, unknown>) => {
            const { session_id, experiment_name } = args as {
              session_id: string;
              experiment_name: string;
            };
            const assignment = ab.assign(session_id, experiment_name);
            if (!assignment) {
              return {
                content: [{ type: 'text', text: `Experiment not found: ${experiment_name}` }],
                isError: true,
              };
            }
            return { content: [{ type: 'text', text: JSON.stringify(assignment, null, 2) }] };
          },
        ) as McpHandler,
      },
      [{ name: 'conduit_ab_assign' }],
    ),
  );

  entries.push(
    ...group({
      name: 'conduit_ab_list',
      description: 'List all A/B experiments.',
      schema: {},
      handler: withReporting('conduit_ab_list', obs, sessionId, async () => {
        const experiments = ab.listExperiments();
        return { content: [{ type: 'text', text: JSON.stringify(experiments, null, 2) }] };
      }) as McpHandler,
    }),
  );

  return entries;
}

// ---------------------------------------------------------------------------
// Register every entry against a live McpServer instance
// ---------------------------------------------------------------------------

export function registerAllTools(server: McpServer, deps: ConduitDeps): ToolSurfaceEntry[] {
  const entries = buildToolSurface(deps);
  for (const entry of entries) {
    // Cast to any for the variadic overload — the SDK's ToolCallback
    // expects a Zod-shaped arg object which matches our schema.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.tool as any)(entry.name, entry.description, entry.schema, entry.handler);
  }
  return entries;
}
