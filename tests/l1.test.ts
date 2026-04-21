import { describe, it, expect, beforeEach } from 'vitest';
import { LazyToolRegistry } from '../src/l1-tool-registry.js';

describe('L1 — LazyToolRegistry', () => {
  let registry: LazyToolRegistry;

  beforeEach(() => {
    registry = new LazyToolRegistry();
    registry.registerMany([
      { name: 'read_file', description: 'Read a file from disk', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, handler: async ({ path }) => `content of ${path}` },
      { name: 'write_file', description: 'Write content to a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }, handler: async () => 'ok' },
      { name: 'search_code', description: 'Search codebase for a pattern', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, handler: async () => [] },
      { name: 'run_tests', description: 'Run test suite', inputSchema: { type: 'object' }, handler: async () => 'passed' },
      { name: 'git_commit', description: 'Create a git commit', inputSchema: { type: 'object' }, handler: async () => 'committed' },
    ]);
  });

  it('searchTools returns only name and description, never schema', () => {
    const results = registry.searchTools('file');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('description');
      expect(r).not.toHaveProperty('inputSchema');
      expect(r).not.toHaveProperty('handler');
    }
  });

  it('searchTools matches by name', () => {
    const results = registry.searchTools('file');
    const names = results.map((r) => r.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
  });

  it('searchTools matches by description', () => {
    const results = registry.searchTools('codebase');
    expect(results.map((r) => r.name)).toContain('search_code');
  });

  it('searchTools respects max_results', () => {
    const results = registry.searchTools('file', 1);
    expect(results).toHaveLength(1);
  });

  it('searchTools returns empty for no match', () => {
    const results = registry.searchTools('xyznonexistent');
    expect(results).toHaveLength(0);
  });

  it('describeTool returns full definition including schema', () => {
    const tool = registry.describeTool('read_file');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('read_file');
    expect(tool!.inputSchema).toBeDefined();
    expect(tool!.handler).toBeDefined();
  });

  it('describeTool returns undefined for unknown tool', () => {
    expect(registry.describeTool('nonexistent')).toBeUndefined();
  });

  it('executeTool calls handler with args', async () => {
    const result = await registry.executeTool('read_file', { path: '/tmp/test.txt' });
    expect(result).toBe('content of /tmp/test.txt');
  });

  it('executeTool throws for unknown tool', async () => {
    await expect(registry.executeTool('ghost', {})).rejects.toThrow('Tool not found');
  });

  it('size returns correct count', () => {
    expect(registry.size()).toBe(5);
  });

  it('listAll returns name and description for all tools', () => {
    const all = registry.listAll();
    expect(all).toHaveLength(5);
    for (const t of all) {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('description');
    }
  });

  it('registerMany adds multiple tools', () => {
    const r2 = new LazyToolRegistry();
    r2.registerMany([
      { name: 'a', description: 'A', inputSchema: {}, handler: async () => null },
      { name: 'b', description: 'B', inputSchema: {}, handler: async () => null },
    ]);
    expect(r2.size()).toBe(2);
  });

  it('register overwrites existing tool', () => {
    registry.register({ name: 'read_file', description: 'Updated', inputSchema: {}, handler: async () => 'new' });
    expect(registry.describeTool('read_file')!.description).toBe('Updated');
    expect(registry.size()).toBe(5);
  });
});
