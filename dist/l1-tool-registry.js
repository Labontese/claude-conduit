export class LazyToolRegistry {
    tools = new Map();
    register(tool) {
        this.tools.set(tool.name, tool);
    }
    registerMany(tools) {
        for (const t of tools)
            this.register(t);
    }
    searchTools(query, maxResults = 5) {
        const q = query.toLowerCase();
        const results = [];
        for (const [, tool] of this.tools) {
            const score = (tool.name.toLowerCase().includes(q) ? 2 : 0) +
                (tool.description.toLowerCase().includes(q) ? 1 : 0);
            if (score > 0)
                results.push({ name: tool.name, description: tool.description, score });
        }
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults)
            .map(({ name, description }) => ({ name, description }));
    }
    describeTool(name) {
        return this.tools.get(name);
    }
    async executeTool(name, args) {
        const tool = this.tools.get(name);
        if (!tool)
            throw new Error(`Tool not found: ${name}`);
        return tool.handler(args);
    }
    listAll() {
        return Array.from(this.tools.values()).map((t) => ({
            name: t.name,
            description: t.description,
        }));
    }
    size() {
        return this.tools.size;
    }
}
