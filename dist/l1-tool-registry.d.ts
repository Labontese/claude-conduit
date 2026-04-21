export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
}
export declare class LazyToolRegistry {
    private tools;
    register(tool: ToolDefinition): void;
    registerMany(tools: ToolDefinition[]): void;
    searchTools(query: string, maxResults?: number): Array<{
        name: string;
        description: string;
    }>;
    describeTool(name: string): ToolDefinition | undefined;
    executeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    listAll(): Array<{
        name: string;
        description: string;
    }>;
    size(): number;
}
