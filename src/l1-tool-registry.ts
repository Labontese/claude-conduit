export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export class LazyToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: ToolDefinition[]): void {
    for (const t of tools) this.register(t);
  }

  searchTools(query: string, maxResults = 5): Array<{ name: string; description: string }> {
    const q = query.toLowerCase();
    const results: Array<{ name: string; description: string; score: number }> = [];
    for (const [, tool] of this.tools) {
      const score =
        (tool.name.toLowerCase().includes(q) ? 2 : 0) +
        (tool.description.toLowerCase().includes(q) ? 1 : 0);
      if (score > 0) results.push({ name: tool.name, description: tool.description, score });
    }
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(({ name, description }) => ({ name, description }));
  }

  describeTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.handler(args);
  }

  listAll(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  size(): number {
    return this.tools.size;
  }
}
