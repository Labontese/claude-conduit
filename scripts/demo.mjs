#!/usr/bin/env node
/**
 * claude-conduit live-demo
 *
 * Importerar conduits funktioner direkt (inte via MCP) och bevisar med
 * konkreta siffror att L2 (dedup), L3 (compress) och L7 (handoff) funkar.
 *
 * Kör:  node scripts/demo.mjs
 *
 * Om ANTHROPIC_API_KEY inte är satt skippas L3-demot graciöst.
 * L7 har inbyggd sync-fallback och fungerar utan API-nyckel.
 */

import { SemanticDeduplicator } from '../dist/l2-deduplication.js';
import { ContextCompressor } from '../dist/l3-compressor.js';
import { AgentHandoffCompressor } from '../dist/l7-handoff.js';

// ---- helpers -------------------------------------------------------------
const estimateTokens = (text) => Math.ceil(text.length / 4);

// Haiku 4.5 pris per 1M tokens (2026-04 enligt Anthropic docs)
const HAIKU_INPUT_PER_MTOK = 0.8;   // USD
const HAIKU_OUTPUT_PER_MTOK = 4.0;  // USD

const hr = (title) => {
  const line = '='.repeat(72);
  console.log(`\n${line}\n  ${title}\n${line}`);
};

const sub = (title) => console.log(`\n-- ${title} --`);

// ==========================================================================
// DEMO 1 — conduit_deduplicate (L2)
// ==========================================================================
async function demoDedup() {
  hr('DEMO 1 — L2 Semantisk deduplicering (conduit_deduplicate)');

  // 10 block. Måste vara >100 tecken för att MinHash-vägen ska triggas.
  // Några är exakta dubletter, några är semantiskt lika men inte exakta.
  const blocks = [
    {
      role: 'user',
      content:
        'React performance tips: memoize expensive components with React.memo, use useCallback for handlers, and avoid inline object creation in render. Profiling with React DevTools is essential.',
    },
    {
      role: 'user',
      content:
        'Tips for react performance: memoize expensive components with React.memo, use useCallback for handlers, and avoid inline object creation in render. Profiling with React DevTools is essential.',
    },
    {
      role: 'user',
      content:
        'To optimize React apps you should memoize expensive components with React.memo, use useCallback for event handlers, and never create inline objects in render. React DevTools profiler helps a lot.',
    },
    {
      role: 'assistant',
      content:
        'Docker Compose lets you define multi-container applications in a single YAML file. Each service gets its own container, network aliases are automatic, and volumes persist data across restarts.',
    },
    {
      role: 'assistant',
      content:
        'Docker Compose lets you define multi-container applications in a single YAML file. Each service gets its own container, network aliases are automatic, and volumes persist data across restarts.',
    },
    {
      role: 'user',
      content:
        'TypeScript generics allow you to write reusable code that works across many types. Use <T extends Constraint> to narrow, default type parameters for ergonomics, and conditional types for branching.',
    },
    {
      role: 'user',
      content:
        'SQLite is a self-contained, serverless SQL database engine. It stores an entire database in a single cross-platform file and has bindings for virtually every programming language.',
    },
    {
      role: 'assistant',
      content:
        'When writing Bash scripts always quote variables, use set -euo pipefail for strict mode, and prefer [[ ]] over [ ] for conditionals. shellcheck catches most bugs before they bite.',
    },
    {
      role: 'user',
      content:
        'Prompt caching in the Anthropic API lets you mark stable prefixes (tools, system, long context) as cache_control, which slashes input cost by up to 90% on repeated calls within 5 minutes.',
    },
    {
      role: 'user',
      content:
        'The Anthropic prompt cache API allows you to mark stable prefixes like tools, system prompts, and long context with cache_control — which can cut input cost by up to 90% on repeated calls within the 5 minute TTL.',
    },
  ];

  const totalInputChars = blocks.reduce((s, b) => s + b.content.length, 0);
  const totalInputTokens = estimateTokens(
    blocks.map((b) => b.content).join('')
  );

  console.log(`Input-block: ${blocks.length}`);
  console.log(`Totalt input-tecken: ${totalInputChars}`);
  console.log(`Uppskattade input-tokens: ${totalInputTokens}`);

  const dedup = new SemanticDeduplicator();
  const result = dedup.deduplicate(blocks, 0.6); // lägre threshold så MinHash fångar semantiska lika

  sub('Resultat');
  console.log(`Antal block efter dedup (ej markerade): ${result.stats.blocks_total - result.stats.blocks_deduplicated}`);
  console.log(`Antal deduplicerade block: ${result.stats.blocks_deduplicated}`);
  console.log(`Strategi: ${result.stats.strategy_used}`);
  console.log(`Tokens sparade (estimate): ${result.stats.tokens_saved_estimate}`);

  sub('Detaljer per block');
  result.messages.forEach((b, i) => {
    const orig = blocks[i].content;
    const preview = orig.slice(0, 60).replace(/\s+/g, ' ');
    if (b.deduplicated) {
      console.log(
        `  [${i}] DUP  "${preview}..."\n       -> ${b.content}`
      );
    } else {
      console.log(`  [${i}] keep "${preview}..."  (hash=${b.hash})`);
    }
  });

  sub('Token-besparing');
  const savedTokens = result.stats.tokens_saved_estimate;
  const savingPct = ((savedTokens / totalInputTokens) * 100).toFixed(1);
  console.log(
    `Besparing: ~${savedTokens} tokens av ${totalInputTokens} (${savingPct}%)`
  );
  console.log(
    `Vid Haiku input-pris ($${HAIKU_INPUT_PER_MTOK}/Mtok): $${(
      (savedTokens / 1_000_000) *
      HAIKU_INPUT_PER_MTOK
    ).toFixed(6)} per körning`
  );
}

// ==========================================================================
// DEMO 2 — conduit_compress (L3) — bara om ANTHROPIC_API_KEY finns
// ==========================================================================
async function demoCompress() {
  hr('DEMO 2 — L3 Kontextkomprimering (conduit_compress)');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY saknas — L3-demot skippas graciöst.');
    console.log('Sätt nyckeln och kör om scriptet för att se komprimering i action.');
    console.log('(conduit_compress har även en sync-fallback, men den uppdaterar');
    console.log(' inte stats på samma sätt som live-API-anropet.)');
    return;
  }

  // Generera ca 10 000 tecken syntetisk "chattlogg"
  const messages = [];
  const topics = [
    'React Server Components rendering lifecycle',
    'PostgreSQL query planner and index selection',
    'TypeScript discriminated unions for state machines',
    'Docker multi-stage builds and layer caching',
    'Anthropic prompt caching TTL behaviour',
  ];
  for (let i = 0; i < 20; i++) {
    const topic = topics[i % topics.length];
    messages.push({
      role: 'user',
      content: `Can you explain ${topic}? I'm particularly confused about the edge cases and how they interact with other features. Give concrete examples where possible.`,
    });
    messages.push({
      role: 'assistant',
      content: `Sure! ${topic} works by first evaluating the common path, then falling back to specialized handling when preconditions are not met. The key insight is that the runtime distinguishes stable prefixes from volatile suffixes, which enables aggressive reuse. In practice you usually want to profile before optimizing, because the theoretical wins rarely match real-world measurements. A common pitfall is assuming the framework auto-detects your intent; it doesn't. You have to be explicit. Another gotcha is that error handling rarely composes the way you think — nested try/catch looks clean but often masks the real failure. Use structured logging and correlation IDs so you can reconstruct what happened after the fact. Finally, remember that benchmarks lie: measure in production with real traffic shapes.`,
    });
  }

  const inputText = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  const inputTokens = estimateTokens(inputText);
  console.log(`Input-meddelanden: ${messages.length}`);
  console.log(`Input-tecken: ${inputText.length}`);
  console.log(`Uppskattade input-tokens: ${inputTokens}`);

  const compressor = new ContextCompressor();
  console.log(`hasApiKey(): ${compressor.hasApiKey()}`);

  sub('Anropar Haiku för komprimering...');
  const t0 = Date.now();
  const result = await compressor.compress(messages, {
    triggerTokens: 1000, // tvinga komprimering även för måttlig input
    keepRecentTurns: 4,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  sub('Resultat');
  console.log(`Komprimerades: ${result.compressed}`);
  console.log(`Tid: ${elapsed}s`);
  console.log(`Turns före: ${result.stats.turns_before}`);
  console.log(`Turns efter: ${result.stats.turns_after}`);
  console.log(`Tokens före (est): ${result.stats.tokens_before_estimate}`);
  console.log(`Tokens efter (est): ${result.stats.tokens_after_estimate}`);
  console.log(
    `Compression ratio: ${(result.stats.compression_ratio * 100).toFixed(1)}%`
  );

  const saved = result.stats.tokens_before_estimate - result.stats.tokens_after_estimate;
  const savingPct = ((saved / result.stats.tokens_before_estimate) * 100).toFixed(1);
  const savedUsd = (saved / 1_000_000) * HAIKU_INPUT_PER_MTOK;

  sub('Besparing');
  console.log(`Token-besparing: ${saved} tokens (${savingPct}%)`);
  console.log(
    `Uppskattad kostnad för att skicka ursprungstexten som input till Haiku: $${(
      (result.stats.tokens_before_estimate / 1_000_000) *
      HAIKU_INPUT_PER_MTOK
    ).toFixed(6)}`
  );
  console.log(
    `Uppskattad kostnad efter komprimering: $${(
      (result.stats.tokens_after_estimate / 1_000_000) *
      HAIKU_INPUT_PER_MTOK
    ).toFixed(6)}`
  );
  console.log(`Besparing per framtida anrop med samma kontext: $${savedUsd.toFixed(6)}`);
  console.log(
    '(OBS: själva komprimeringsanropet kostar också — men vinsten realiseras över N framtida anrop som återanvänder den komprimerade kontexten.)'
  );
}

// ==========================================================================
// DEMO 3 — conduit_handoff (L7)
// ==========================================================================
async function demoHandoff() {
  hr('DEMO 3 — L7 Agent handoff-komprimering (conduit_handoff)');

  // Simulera ett agent-state: ca 5000 tecken samtalshistorik
  const messages = [
    {
      role: 'user',
      content:
        'Hej Anna, jag behöver en researchbrief inför möte med DRC Systems. De är en indisk IT-byrå som vill bli named partner i Karins a11y-program.',
    },
    {
      role: 'assistant',
      content:
        'Hej Daniel! Jag sätter igång. Vad vet vi om DRC Systems sedan tidigare? Har vi fått material från dem, eller ska jag börja från noll?',
    },
    {
      role: 'user',
      content:
        'Karin har haft ett första samtal, men inget skriftligt. Vi vet att de är ca 50 personer, baserade i Pune, och har fokus på WordPress-utveckling. De vill komma in på EU-marknaden.',
    },
    {
      role: 'assistant',
      content:
        'Okej. Jag kollar: företagsregister, LinkedIn-närvaro, tidigare kunder, ev. WCAG-erfarenhet, och om de har några tidigare EU-GDPR-avtal. Hur djup ska briefen vara — exec-summary eller 10-sidig dossier?',
    },
    {
      role: 'user',
      content:
        'Exec-summary räcker, men inkludera red flags. Karin är paranoid kring compliance efter senaste bråket med en annan partner. Jag vill också veta om de har någon erfarenhet av SaaS eller om de bara bygger custom.',
    },
    {
      role: 'assistant',
      content:
        'Uppfattat. Red flags = compliance, finansiell stabilitet, referenser. Jag kollar även SaaS vs custom. När behöver du briefen?',
    },
    {
      role: 'user',
      content:
        'Mötet är på onsdag nästa vecka, så tisdag kväll vore bra. Jag vill läsa den i lugn och ro. Om du är osäker på något så flagga det — jag hellre ser "osäkert" än en gissning.',
    },
    {
      role: 'assistant',
      content:
        'Deal. Tisdag kväll det är. Jag flaggar explicit allt osäkert. En sak till: ska jag också rekommendera en förhandlingsstrategi eller bara leverera fakta? Strategi kan Stella ta om du hellre vill det.',
    },
    {
      role: 'user',
      content:
        'Bara fakta. Stella får strategin separat. Men inkludera en TL;DR-sektion högst upp med "ska vi gå vidare eller inte"-rekommendation baserad på fakta.',
    },
    {
      role: 'assistant',
      content:
        'Perfekt, då är scope låst. Jag startar research nu. Första iteration kommer som draft på måndag kväll så du har en dag att kommentera innan jag polerar.',
    },
    {
      role: 'user',
      content:
        'Bra. En sista sak — Karin sa något om att en av hennes amerikanska kunder redan har jobbat med DRC tidigare och att det slutade illa. Försök hitta vem det var och vad som hände.',
    },
    {
      role: 'assistant',
      content:
        'Noterat — jag kollar Karins LinkedIn-nätverk och försöker spåra det via referensen. Om jag inte hittar det inom rimlig tid flaggar jag det som "ej verifierat" i briefen.',
    },
  ];

  // Pad upp till ~5000 tecken om det behövs
  const currentLen = messages.reduce((s, m) => s + m.content.length, 0);
  console.log(`Agent-state (samtalshistorik): ${messages.length} meddelanden, ${currentLen} tecken`);

  const rawText = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
  const rawTokens = estimateTokens(rawText);
  console.log(`Uppskattade raw-tokens: ${rawTokens}`);

  const handoff = new AgentHandoffCompressor();
  sub('Komprimerar handoff (Anna -> Stella)...');
  const { contract, system_prompt } = await handoff.compress({
    from_agent: 'Anna',
    to_agent: 'Stella',
    task: 'Ta fram förhandlingsstrategi för DRC Systems-mötet baserat på Annas research',
    messages,
    context_hint: 'Karin är paranoid kring compliance. En amerikansk kund har haft dålig erfarenhet av DRC tidigare.',
  });

  sub('Kontrakt (komprimerat handoff)');
  console.log(`ID: ${contract.id}`);
  console.log(`From: ${contract.from_agent} -> To: ${contract.to_agent}`);
  console.log(`Task: ${contract.task}`);
  console.log(`Relevant context: ${contract.relevant_context.slice(0, 200)}...`);
  console.log(`Expected output: ${contract.expected_output}`);
  console.log(`Constraints: ${contract.constraints.length} st`);
  console.log(`Prior decisions: ${contract.prior_decisions.length} st`);
  console.log(`Open questions: ${contract.open_questions.length} st`);

  sub('Storlek');
  console.log(`Raw tokens: ${contract.raw_tokens}`);
  console.log(`Compressed tokens: ${contract.compressed_tokens}`);
  console.log(
    `Compression ratio: ${(contract.compression_ratio * 100).toFixed(1)}%`
  );
  const saved = contract.raw_tokens - contract.compressed_tokens;
  const savingPct = ((saved / contract.raw_tokens) * 100).toFixed(1);
  console.log(`Besparing: ${saved} tokens (${savingPct}%)`);

  // Hämta tillbaka via fetch
  sub('Fetch-back (conduit_fetch_handoff)');
  const fetched = handoff.fetch(contract.id);
  if (fetched && fetched.id === contract.id) {
    console.log(`OK — hämtade tillbaka contract med id ${fetched.id}`);
    console.log(`Matchar original: ${JSON.stringify(fetched) === JSON.stringify(contract)}`);
  } else {
    console.log('FAIL — kunde inte hämta tillbaka');
  }

  sub('System-prompt som Stella skulle få (förhandsvisning)');
  console.log(system_prompt.split('\n').slice(0, 12).join('\n'));
  console.log(`... (${system_prompt.length} tecken totalt)`);

  sub('Not');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      'ANTHROPIC_API_KEY saknas — handoff använde sync-fallback (enkel truncation, inte Haiku-summary).'
    );
    console.log(
      'Med API-nyckel extraherar Haiku strukturerade constraints/prior_decisions/open_questions ur samtalet.'
    );
  } else {
    console.log('ANTHROPIC_API_KEY satt — handoff använde Haiku för strukturerad extraktion.');
  }
}

// ==========================================================================
// main
// ==========================================================================
async function main() {
  console.log('claude-conduit live-demo — ' + new Date().toISOString());
  console.log(`Node: ${process.version}`);
  console.log(
    `ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'satt' : 'EJ satt (L3 skippas, L7 använder fallback)'}`
  );

  try {
    await demoDedup();
  } catch (e) {
    console.error('Demo 1 (L2) kraschade:', e);
  }

  try {
    await demoCompress();
  } catch (e) {
    console.error('Demo 2 (L3) kraschade:', e);
  }

  try {
    await demoHandoff();
  } catch (e) {
    console.error('Demo 3 (L7) kraschade:', e);
  }

  console.log('\n' + '='.repeat(72));
  console.log('  Demo klar.');
  console.log('='.repeat(72));
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
