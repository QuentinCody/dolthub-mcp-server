import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createGetSchemaHandler } from "@bio-mcp/shared/staging/utils";

interface SchemaEnv {
    DOLTHUB_DATA_DO?: unknown;
}

export function registerGetSchema(server: McpServer, env?: SchemaEnv): void {
    const handler = createGetSchemaHandler("DOLTHUB_DATA_DO", "dolthub");

    server.registerTool(
        "dolthub_get_schema",
        {
            title: "Get Staged Data Schema",
            description:
                "Get schema for data that was explicitly staged via db.stage() in dolthub_execute. " +
                "Shows table structures and row counts for locally staged datasets.",
            inputSchema: {
                data_access_id: z.string().min(1).optional().describe(
                    "Data access ID from db.stage(). If omitted, lists all staged datasets.",
                ),
            },
        },
        async (args, extra) => {
            const runtimeEnv = env || (extra as { env?: SchemaEnv })?.env || {};
            return handler(
                args as Record<string, unknown>,
                runtimeEnv as Record<string, unknown>,
                (extra as { sessionId?: string })?.sessionId,
            );
        },
    );
}
