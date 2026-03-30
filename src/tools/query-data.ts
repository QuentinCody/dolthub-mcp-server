import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createQueryDataHandler } from "@bio-mcp/shared/staging/utils";

interface QueryEnv {
    DOLTHUB_DATA_DO?: unknown;
}

export function registerQueryData(server: McpServer, env?: QueryEnv): void {
    const handler = createQueryDataHandler("DOLTHUB_DATA_DO", "dolthub");

    server.registerTool(
        "dolthub_query_data",
        {
            title: "Query Locally Staged DoltHub Data",
            description:
                "Query data that was explicitly staged via db.stage() in dolthub_execute. " +
                "Use this for follow-up SQL queries on previously staged result sets.",
            inputSchema: {
                data_access_id: z.string().min(1).describe("Data access ID returned by db.stage()"),
                sql: z.string().min(1).describe("SQL query to execute against the staged data"),
                limit: z.number().int().positive().max(10000).default(100).optional().describe("Maximum rows to return (default: 100)"),
            },
        },
        async (args, extra) => {
            const runtimeEnv = env || (extra as { env?: QueryEnv })?.env || {};
            return handler(args as Record<string, unknown>, runtimeEnv as Record<string, unknown>);
        },
    );
}
