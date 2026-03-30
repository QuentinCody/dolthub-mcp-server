import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { dolthubCatalog } from "../spec/catalog";
import { createDoltHubApiFetch } from "../lib/api-adapter";

interface CodeModeEnv {
    DOLTHUB_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

export function registerCodeMode(
    server: McpServer,
    env: CodeModeEnv,
): void {
    const apiFetch = createDoltHubApiFetch();

    const searchTool = createSearchTool({
        prefix: "dolthub",
        catalog: dolthubCatalog,
    });
    searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

    const executeTool = createExecuteTool({
        prefix: "dolthub",
        catalog: dolthubCatalog,
        apiFetch,
        doNamespace: env.DOLTHUB_DATA_DO,
        loader: env.CODE_MODE_LOADER,
        timeout: 60_000, // DoltHub queries on large tables can be slow
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
