import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ObservabilityBus } from '../src/l6-observability.js';

describe('L6 — ObservabilityBus', () => {
  let obs: ObservabilityBus;

  beforeEach(() => {
    obs = new ObservabilityBus(':memory:');
  });

  afterEach(() => {
    obs.close();
  });

  it('creates a session on init', () => {
    const report = obs.getSessionReport();
    expect(report.sessionId).toBeTruthy();
  });

  it('getCurrentSessionId returns valid UUID', () => {
    const id = obs.getCurrentSessionId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('recordRequest stores a request', () => {
    const sessionId = obs.getCurrentSessionId();
    obs.recordRequest({ sessionId, model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 200 });
    const report = obs.getSessionReport();
    expect(report.requestCount).toBe(1);
    expect(report.totalInputTokens).toBe(1000);
    expect(report.totalOutputTokens).toBe(200);
  });

  it('report accumulates multiple requests', () => {
    const sessionId = obs.getCurrentSessionId();
    obs.recordRequest({ sessionId, model: 'claude-sonnet-4-6', inputTokens: 500, outputTokens: 100 });
    obs.recordRequest({ sessionId, model: 'claude-sonnet-4-6', inputTokens: 500, outputTokens: 100 });
    const report = obs.getSessionReport();
    expect(report.requestCount).toBe(2);
    expect(report.totalInputTokens).toBe(1000);
  });

  it('cache hit rate is 0 with no cache reads', () => {
    const sessionId = obs.getCurrentSessionId();
    obs.recordRequest({ sessionId, model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 100 });
    expect(obs.getSessionReport().avgCacheHitRate).toBe(0);
  });

  it('cache hit rate calculated correctly', () => {
    const sessionId = obs.getCurrentSessionId();
    obs.recordRequest({ sessionId, model: 'claude-sonnet-4-6', inputTokens: 500, outputTokens: 100, cacheReadTokens: 500 });
    const report = obs.getSessionReport();
    expect(report.avgCacheHitRate).toBeCloseTo(0.5);
  });

  it('formatReport returns markdown string', () => {
    const report = obs.getSessionReport();
    const text = obs.formatReport(report);
    expect(text).toContain('conduit_report');
    expect(text).toContain('|');
  });

  it('formatReport contains all expected metrics', () => {
    const report = obs.getSessionReport();
    const text = obs.formatReport(report);
    expect(text).toContain('Requests');
    expect(text).toContain('Cache hit rate');
    expect(text).toContain('Savings');
  });

  it('startSession creates new session', () => {
    const newId = obs.startSession('anna', 'claude-code');
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(obs.getCurrentSessionId());
    const report = obs.getSessionReport(newId);
    expect(report.requestCount).toBe(0);
  });

  it('throws for unknown session', () => {
    expect(() => obs.getSessionReport('nonexistent-uuid')).toThrow();
  });

  it('savedTokens accumulated', () => {
    const sessionId = obs.getCurrentSessionId();
    obs.recordRequest({ sessionId, model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 100, savedTokens: 400 });
    obs.recordRequest({ sessionId, model: 'claude-sonnet-4-6', inputTokens: 800, outputTokens: 80, savedTokens: 300 });
    expect(obs.getSessionReport().totalSavedTokens).toBe(700);
  });

  it('costUsd accumulated', () => {
    const sessionId = obs.getCurrentSessionId();
    obs.recordRequest({ sessionId, model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 100, costUsd: 0.003 });
    obs.recordRequest({ sessionId, model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 100, costUsd: 0.004 });
    expect(obs.getSessionReport().totalCostUsd).toBeCloseTo(0.007);
  });

  it('separate sessions do not interfere', () => {
    const s1 = obs.getCurrentSessionId();
    const s2 = obs.startSession();
    obs.recordRequest({ sessionId: s1, model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 10 });
    obs.recordRequest({ sessionId: s2, model: 'claude-haiku-4-5', inputTokens: 200, outputTokens: 20 });
    expect(obs.getSessionReport(s1).totalInputTokens).toBe(100);
    expect(obs.getSessionReport(s2).totalInputTokens).toBe(200);
  });

  it('recordRequest returns request id string', () => {
    const sessionId = obs.getCurrentSessionId();
    const id = obs.recordRequest({ sessionId, model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 10 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('empty session report has zero counts', () => {
    const report = obs.getSessionReport();
    expect(report.requestCount).toBe(0);
    expect(report.totalInputTokens).toBe(0);
    expect(report.avgCacheHitRate).toBe(0);
  });
});
