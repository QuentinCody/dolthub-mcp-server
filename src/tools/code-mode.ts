import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import type { McpServer } from "@bio-mcp/shared/mcp";
import { createDoltHubApiFetch } from "../lib/api-adapter";
import { dolthubResponse } from "../lib/tool-result";
import { dolthubCatalog } from "../spec/catalog";

interface CodeModeEnv {
    DOLTHUB_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
    DOLTHUB_TOKEN?: string;
}

export function registerCodeMode(
    server: McpServer,
    env: CodeModeEnv,
): void {
    const apiFetch = createDoltHubApiFetch(env.DOLTHUB_TOKEN);
    const registrar = {tool: (...args: unknown[]) => {
        const [name, description, schema, original] = args;
        const work = original as (...values: unknown[]) => Promise<Parameters<typeof dolthubResponse>[0] extends () => Promise<infer R> ? R : never>;
        const wrapped = (input: unknown, extra: unknown) => dolthubResponse(() => work(input, extra), env, String(name), extra, input);
        const register = server.tool.bind(server) as (...values: unknown[]) => void;
        register(name, description, schema, wrapped); register(`mcp_${String(name)}`, description, schema, wrapped);
    }};

    const searchTool = createSearchTool({
        prefix: "dolthub",
        catalog: dolthubCatalog,
    });
    searchTool.register(registrar);

    const executeTool = createExecuteTool({
        prefix: "dolthub",
        // Verifiable provenance: dolthub_execute results carry a _meta.citation.
        source: { id: "dolthub", name: "DoltHub", url: "https://www.dolthub.com" },
        catalog: dolthubCatalog,
        apiFetch,
        doNamespace: env.DOLTHUB_DATA_DO,
        loader: env.CODE_MODE_LOADER,
        maxInlineBytes: 30 * 1024,
        preserveApiErrors: true,
        timeout: 90_000,
    });
    executeTool.register(registrar);
}
