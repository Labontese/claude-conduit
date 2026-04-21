import { describe, it, expect } from 'vitest';
import { AgentHandoffCompressor } from '../src/l7-handoff.js';

const make = (role: 'user' | 'assistant', content: string) => ({ role, content });

const conversation = [
  make('user', 'We need to build an authentication system for the API.'),
  make('assistant', 'I recommend JWT tokens with a 1-hour expiry. We should store refresh tokens in Redis.'),
  make('user', 'Good. Use RS256 signing, not HS256. The secret is in vault at secrets/jwt-key.'),
  make('assistant', 'Understood. I will implement POST /auth/login, POST /auth/refresh, POST /auth/logout.'),
  make('user', 'Also add rate limiting — max 5 login attempts per IP per minute.'),
  make('assistant', 'Will add rate limiting via Redis sliding window. Starting implementation now.'),
];

describe('L7 — AgentHandoffCompressor', () => {
  // No API key — uses sync fallback
  const compressor = new AgentHandoffCompressor('');

  it('returns contract and system_prompt', async () => {
    const result = await compressor.compress({
      from_agent: 'emelie',
      to_agent: 'nova',
      task: 'Implement JWT authentication for the API',
      messages: conversation,
    });
    expect(result).toHaveProperty('contract');
    expect(result).toHaveProperty('system_prompt');
  });

  it('contract has required fields', async () => {
    const { contract } = await compressor.compress({
      from_agent: 'emelie',
      to_agent: 'nova',
      task: 'Implement JWT authentication',
      messages: conversation,
    });
    expect(contract).toHaveProperty('id');
    expect(contract).toHaveProperty('ts');
    expect(contract).toHaveProperty('from_agent', 'emelie');
    expect(contract).toHaveProperty('to_agent', 'nova');
    expect(contract).toHaveProperty('task');
    expect(contract).toHaveProperty('relevant_context');
    expect(contract).toHaveProperty('expected_output');
    expect(contract).toHaveProperty('constraints');
    expect(contract).toHaveProperty('prior_decisions');
    expect(contract).toHaveProperty('open_questions');
    expect(contract).toHaveProperty('raw_tokens');
    expect(contract).toHaveProperty('compressed_tokens');
    expect(contract).toHaveProperty('compression_ratio');
  });

  it('contract id is valid UUID', async () => {
    const { contract } = await compressor.compress({
      from_agent: 'anna',
      to_agent: 'wilma',
      task: 'Deploy the service',
      messages: conversation,
    });
    expect(contract.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('compression_ratio <= 1 (compressed is smaller)', async () => {
    const { contract } = await compressor.compress({
      from_agent: 'nova',
      to_agent: 'saga',
      task: 'Build the dashboard',
      messages: conversation,
    });
    expect(contract.compression_ratio).toBeLessThanOrEqual(1);
  });

  it('raw_tokens > 0', async () => {
    const { contract } = await compressor.compress({
      from_agent: 'a',
      to_agent: 'b',
      task: 'Do something',
      messages: conversation,
    });
    expect(contract.raw_tokens).toBeGreaterThan(0);
  });

  it('system_prompt contains from_agent name', async () => {
    const { system_prompt } = await compressor.compress({
      from_agent: 'emelie',
      to_agent: 'nova',
      task: 'Build auth',
      messages: conversation,
    });
    expect(system_prompt).toContain('emelie');
  });

  it('system_prompt contains handoff ID', async () => {
    const { contract, system_prompt } = await compressor.compress({
      from_agent: 'a',
      to_agent: 'b',
      task: 'Test',
      messages: conversation,
    });
    expect(system_prompt).toContain(contract.id);
  });

  it('fetch returns stored contract', async () => {
    const { contract } = await compressor.compress({
      from_agent: 'x',
      to_agent: 'y',
      task: 'Fetch test',
      messages: conversation,
    });
    const fetched = compressor.fetch(contract.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(contract.id);
  });

  it('fetch returns undefined for unknown id', () => {
    expect(compressor.fetch('nonexistent-id')).toBeUndefined();
  });

  it('constraints is array', async () => {
    const { contract } = await compressor.compress({
      from_agent: 'a', to_agent: 'b', task: 't', messages: conversation,
    });
    expect(Array.isArray(contract.constraints)).toBe(true);
  });

  it('handles empty messages', async () => {
    const result = await compressor.compress({
      from_agent: 'a', to_agent: 'b', task: 'Empty test', messages: [],
    });
    expect(result.contract).toBeDefined();
  });
});
