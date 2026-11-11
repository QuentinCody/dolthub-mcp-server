import type { McpServer } from "@bio-mcp/shared/mcp";
import { createQueryDataHandler } from "@bio-mcp/shared/staging/utils";
import { z } from "zod";
import { dolthubResponse } from "../lib/tool-result";

interface QueryEnv {
    DOLTHUB_DATA_DO?: unknown;
}

export function registerQueryData(server: McpServer, env?: QueryEnv): void {
    const handler = createQueryDataHandler("DOLTHUB_DATA_DO", "dolthub");

    for (const toolName of ["dolthub_query_data", "mcp_dolthub_query_data"]) server.registerTool(
        toolName,
        {
            title: "Query Locally Staged DoltHub Data",
            description:
                "Query automatically or explicitly staged data in dolthub_execute. " +
                "Use this for follow-up SQL queries on previously staged result sets.",
            inputSchema: {
                data_access_id: z.string().min(1).describe("Data access ID returned by db.stage()"),
                sql: z.string().min(1).describe("SQL query to execute against the staged data"),
                limit: z.number().int().positive().max(10000).optional().describe("Maximum rows to return (default: 100)"),
            },
        },
        async (args, extra) => {
            const runtimeEnv = env || (extra as { env?: QueryEnv })?.env || {};
            return dolthubResponse(() => handler(args as Record<string, unknown>, runtimeEnv as Record<string, unknown>), runtimeEnv, toolName, extra, args);
        },
    );
}
