export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | Array<{
        type: string;
        text?: string;
        [key: string]: unknown;
    }>;
}
export interface AnthropicRequest {
    model: string;
    max_tokens?: number;
    system?: string | Array<{
        type: string;
        text: string;
        cache_control?: {
            type: string;
        };
    }>;
    messages: AnthropicMessage[];
    tools?: Array<Record<string, unknown>>;
    [key: string]: unknown;
}
export interface CacheMeta {
    input_tokens_before: number;
    input_tokens_after: number;
    saved_tokens: number;
    saved_usd_estimated: number;
    optimizations_applied: string[];
    cache_breakpoints: number;
    notes: string[];
}
export interface WrappedRequest {
    request: AnthropicRequest;
    meta: CacheMeta;
}
export declare class CacheOrchestrator {
    wrapRequest(request: AnthropicRequest, disable?: string[]): WrappedRequest;
}
