import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { FeedbackLoop } from '../src/l8-feedback.js';

describe('L8 — FeedbackLoop', () => {
  let db: Database.Database;
  let loop: FeedbackLoop;

  beforeEach(() => {
    db = new Database(':memory:');
    loop = new FeedbackLoop(db);
  });

  afterEach(() => {
    db.close();
  });

  it('records feedback without error', () => {
    expect(() =>
      loop.recordFeedback({ request_id: 'req-1', rating: 'good', rule_suspected: 'cache_tools' }),
    ).not.toThrow();
  });

  it('getRuleStats returns stats after recording', () => {
    loop.recordFeedback({ request_id: 'r1', rating: 'good', rule_suspected: 'cache_tools' });
    const stats = loop.getRuleStats('cache_tools');
    expect(stats).toBeDefined();
    expect(stats!.evaluations).toBe(1);
    expect(stats!.wins_good).toBe(1);
  });

  it('getRuleStats returns undefined for unknown rule', () => {
    expect(loop.getRuleStats('ghost_rule')).toBeUndefined();
  });

  it('accumulates multiple ratings', () => {
    loop.recordFeedback({ request_id: 'r1', rating: 'good', rule_suspected: 'cache_system' });
    loop.recordFeedback({ request_id: 'r2', rating: 'bad', rule_suspected: 'cache_system' });
    loop.recordFeedback({ request_id: 'r3', rating: 'partial', rule_suspected: 'cache_system' });
    const stats = loop.getRuleStats('cache_system');
    expect(stats!.evaluations).toBe(3);
    expect(stats!.wins_good).toBe(1);
    expect(stats!.wins_bad).toBe(1);
    expect(stats!.wins_partial).toBe(1);
  });

  it('win_rate computed correctly', () => {
    loop.recordFeedback({ request_id: 'r1', rating: 'good', rule_suspected: 'dedup' });
    loop.recordFeedback({ request_id: 'r2', rating: 'good', rule_suspected: 'dedup' });
    loop.recordFeedback({ request_id: 'r3', rating: 'bad', rule_suspected: 'dedup' });
    const stats = loop.getRuleStats('dedup');
    expect(stats!.win_rate).toBeCloseTo(2 / 3);
  });

  it('auto-disables rule with >40% bad rate after 5 evaluations', () => {
    for (let i = 0; i < 3; i++) {
      loop.recordFeedback({ request_id: `r${i}`, rating: 'bad', rule_suspected: 'compress' });
    }
    for (let i = 3; i < 5; i++) {
      loop.recordFeedback({ request_id: `r${i}`, rating: 'good', rule_suspected: 'compress' });
    }
    const stats = loop.getRuleStats('compress');
    expect(stats!.evaluations).toBe(5);
    expect(stats!.enabled).toBe(0);
  });

  it('does not auto-disable with <5 evaluations', () => {
    loop.recordFeedback({ request_id: 'r1', rating: 'bad', rule_suspected: 'cache_tools' });
    loop.recordFeedback({ request_id: 'r2', rating: 'bad', rule_suspected: 'cache_tools' });
    const stats = loop.getRuleStats('cache_tools');
    expect(stats!.enabled).toBe(1);
  });

  it('does not auto-disable with bad rate <=40%', () => {
    for (let i = 0; i < 3; i++) {
      loop.recordFeedback({ request_id: `r${i}`, rating: 'good', rule_suspected: 'lazy_tools' });
    }
    for (let i = 3; i < 5; i++) {
      loop.recordFeedback({ request_id: `r${i}`, rating: 'bad', rule_suspected: 'lazy_tools' });
    }
    const stats = loop.getRuleStats('lazy_tools');
    expect(stats!.enabled).toBe(1);
  });

  it('enableRule re-enables a disabled rule', () => {
    for (let i = 0; i < 5; i++) {
      loop.recordFeedback({ request_id: `r${i}`, rating: 'bad', rule_suspected: 'flaky_rule' });
    }
    expect(loop.getRuleStats('flaky_rule')!.enabled).toBe(0);
    loop.enableRule('flaky_rule');
    expect(loop.getRuleStats('flaky_rule')!.enabled).toBe(1);
  });

  it('getDisabledRules returns disabled rules', () => {
    for (let i = 0; i < 5; i++) {
      loop.recordFeedback({ request_id: `r${i}`, rating: 'bad', rule_suspected: 'bad_rule' });
    }
    expect(loop.getDisabledRules()).toContain('bad_rule');
  });

  it('getAllRuleStats returns all rules', () => {
    loop.recordFeedback({ request_id: 'r1', rating: 'good', rule_suspected: 'rule_a' });
    loop.recordFeedback({ request_id: 'r2', rating: 'bad', rule_suspected: 'rule_b' });
    const all = loop.getAllRuleStats();
    const names = all.map((r) => r.rule_name);
    expect(names).toContain('rule_a');
    expect(names).toContain('rule_b');
  });

  it('feedback without rule_suspected does not crash', () => {
    expect(() =>
      loop.recordFeedback({ request_id: 'r1', rating: 'good' }),
    ).not.toThrow();
  });

  it('formatRuleReport returns markdown table', () => {
    loop.recordFeedback({ request_id: 'r1', rating: 'good', rule_suspected: 'cache_tools' });
    const report = loop.formatRuleReport();
    expect(report).toContain('Rule Stats');
    expect(report).toContain('cache_tools');
    expect(report).toContain('|');
  });

  it('formatRuleReport handles empty state', () => {
    const report = loop.formatRuleReport();
    expect(report).toContain('No feedback');
  });
});
