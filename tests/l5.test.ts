import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ModelRouter } from '../src/l5-router.js';
import { ABTesting } from '../src/l5-ab-testing.js';

describe('L5 — ModelRouter', () => {
  const r = new ModelRouter();

  it('returns sonnet by default (conservative)', () => {
    const d = r.route('Help me write a function', 'conservative');
    expect(d.tier).toBe('sonnet');
  });

  it('routes formatting tasks to haiku (aggressive)', () => {
    const d = r.route('format this JSON output', 'aggressive');
    expect(d.tier).toBe('haiku');
  });

  it('routes architecture tasks to opus', () => {
    const d = r.route('design system for the entire codebase', 'aggressive');
    expect(d.tier).toBe('opus');
  });

  it('force_model overrides routing', () => {
    const d = r.route('simple task', 'aggressive', 'claude-opus-4-7');
    expect(d.model).toBe('claude-opus-4-7');
    expect(d.reason).toContain('override');
  });

  it('policy off always returns sonnet', () => {
    const d = r.route('format this JSON', 'off');
    expect(d.tier).toBe('sonnet');
  });

  it('returns cost_per_1m_input', () => {
    const d = r.route('hello', 'conservative');
    expect(d.cost_per_1m_input).toBeGreaterThan(0);
  });

  it('returns reason string', () => {
    const d = r.route('summarize this text', 'aggressive');
    expect(typeof d.reason).toBe('string');
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it('haiku is cheaper than sonnet', () => {
    const haiku = r.route('translate this', 'aggressive');
    const sonnet = r.route('write a complex algorithm', 'conservative');
    expect(haiku.cost_per_1m_input).toBeLessThanOrEqual(sonnet.cost_per_1m_input);
  });

  it('confidence is between 0 and 1', () => {
    const d = r.route('some task', 'conservative');
    expect(d.confidence).toBeGreaterThan(0);
    expect(d.confidence).toBeLessThanOrEqual(1);
  });
});

describe('L5 — ABTesting', () => {
  let db: Database.Database;
  let ab: ABTesting;

  beforeEach(() => {
    db = new Database(':memory:');
    ab = new ABTesting(db);
  });

  afterEach(() => db.close());

  it('createExperiment returns experiment with id', () => {
    const exp = ab.createExperiment('test-exp', [
      { name: 'control', instruction: 'Be concise.' },
      { name: 'variant', instruction: 'Be detailed.' },
    ]);
    expect(exp.id).toBeTruthy();
    expect(exp.name).toBe('test-exp');
    expect(exp.variants).toHaveLength(2);
  });

  it('throws with fewer than 2 variants', () => {
    expect(() => ab.createExperiment('bad', [{ name: 'only', instruction: 'x' }])).toThrow();
  });

  it('assign returns a variant', () => {
    ab.createExperiment('routing-test', [
      { name: 'a', instruction: 'Short.' },
      { name: 'b', instruction: 'Long.' },
    ]);
    const assignment = ab.assign('session-1', 'routing-test');
    expect(assignment).not.toBeNull();
    expect(['a', 'b']).toContain(assignment!.variant_name);
  });

  it('same session always gets same variant', () => {
    ab.createExperiment('sticky', [
      { name: 'x', instruction: 'X' },
      { name: 'y', instruction: 'Y' },
    ]);
    const first = ab.assign('sess-abc', 'sticky');
    const second = ab.assign('sess-abc', 'sticky');
    expect(first!.variant_name).toBe(second!.variant_name);
  });

  it('assign returns null for unknown experiment', () => {
    expect(ab.assign('s1', 'nonexistent')).toBeNull();
  });

  it('listExperiments returns created experiments', () => {
    ab.createExperiment('e1', [{ name: 'a', instruction: 'A' }, { name: 'b', instruction: 'B' }]);
    ab.createExperiment('e2', [{ name: 'c', instruction: 'C' }, { name: 'd', instruction: 'D' }]);
    const list = ab.listExperiments();
    expect(list.map(e => e.name)).toContain('e1');
    expect(list.map(e => e.name)).toContain('e2');
  });

  it('deactivate stops assignment', () => {
    ab.createExperiment('temp', [{ name: 'a', instruction: 'A' }, { name: 'b', instruction: 'B' }]);
    ab.deactivate('temp');
    expect(ab.assign('s1', 'temp')).toBeNull();
  });
});
