import Database from 'better-sqlite3';
export interface RequestRecord {
    sessionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    latencyMs?: number;
    costUsd?: number;
    baselineCostUsd?: number;
    optimizationsApplied?: string[];
    savedTokens?: number;
}
export interface SessionReport {
    sessionId: string;
    startedAt: number;
    requestCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalSavedTokens: number;
    totalCostUsd: number;
    totalBaselineCostUsd: number;
    avgCacheHitRate: number;
}
export declare class ObservabilityBus {
    private db;
    private currentSessionId;
    constructor(dbPath?: string);
    private initSchema;
    startSession(agentName?: string, client?: string): string;
    recordRequest(record: RequestRecord): string;
    getSessionReport(sessionId?: string): SessionReport;
    formatReport(report: SessionReport): string;
    getCurrentSessionId(): string;
    close(): void;
    getDb(): Database.Database;
}
