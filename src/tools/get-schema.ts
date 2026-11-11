import type { McpServer } from "@bio-mcp/shared/mcp";
import { createGetSchemaHandler } from "@bio-mcp/shared/staging/utils";
import { z } from "zod";
import { dolthubResponse } from "../lib/tool-result";

interface SchemaEnv {
    DOLTHUB_DATA_DO?: unknown;
}

export function registerGetSchema(server: McpServer, env?: SchemaEnv): void {
    const handler = createGetSchemaHandler("DOLTHUB_DATA_DO", "dolthub");

    for (const toolName of ["dolthub_get_schema", "mcp_dolthub_get_schema"]) server.registerTool(
        toolName,
        {
            title: "Get Staged Data Schema",
            description:
                "Get schema for automatically or explicitly staged data in dolthub_execute. " +
                "Shows table structures and row counts for locally staged datasets.",
            inputSchema: {
                data_access_id: z.string().min(1).optional().describe(
                    "Data access ID from db.stage(). If omitted, lists all staged datasets.",
                ),
            },
        },
        async (args, extra) => {
            const runtimeEnv = env || (extra as { env?: SchemaEnv })?.env || {};
            return dolthubResponse(() => handler(
                args as Record<string, unknown>,
                runtimeEnv as Record<string, unknown>,
                (extra as Record<string, unknown>),
            ), runtimeEnv, toolName, extra, args);
        },
    );
}
