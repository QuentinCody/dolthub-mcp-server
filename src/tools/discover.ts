import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dolthubQuery } from "../lib/http";
import {
    createCodeModeResponse,
    createCodeModeError,
} from "@bio-mcp/shared/codemode/response";

export function registerDiscover(server: McpServer): void {
    server.registerTool(
        "dolthub_discover",
        {
            title: "Discover DoltHub Databases",
            description:
                "Explore DoltHub repositories and their schemas. Use this to find databases, list tables, " +
                "describe columns, and preview data before writing queries with dolthub_execute.\n\n" +
                "Actions:\n" +
                "- tables: List all tables in a database (SHOW TABLES)\n" +
                "- describe: Show column names and types for a table (DESCRIBE)\n" +
                "- sample: Preview first 5 rows of a table\n" +
                "- stats: Show row counts for all tables in a database",
            inputSchema: {
                action: z.enum(["tables", "describe", "sample", "stats"]).describe(
                    "What to discover: 'tables' lists all tables, 'describe' shows column schema, " +
                    "'sample' previews rows, 'stats' shows row counts",
                ),
                database: z.string().min(1).describe(
                    "Database in owner/name format (e.g. 'dolthub/hospital-price-transparency-v3')",
                ),
                table: z.string().optional().describe(
                    "Table name — required for 'describe' and 'sample' actions",
                ),
            },
        },
        async (args) => {
            try {
                const dbParts = String(args.database).split("/");
                if (dbParts.length < 2) {
                    return createCodeModeError(
                        "INVALID_ARGUMENTS",
                        "database must be in owner/name format (e.g. 'dolthub/hospital-price-transparency-v3')",
                    );
                }
                const owner = dbParts[0];
                const dbName = dbParts.slice(1).join("/");
                const table = args.table ? String(args.table) : undefined;

                switch (args.action) {
                    case "tables": {
                        const result = await dolthubQuery(owner, dbName, "SHOW TABLES");
                        const tables = result.rows.map((r) => Object.values(r)[0]);
                        return createCodeModeResponse(
                            { database: args.database, tables, table_count: tables.length },
                            { meta: { action: "tables" } },
                        );
                    }

                    case "describe": {
                        if (!table) {
                            return createCodeModeError("MISSING_REQUIRED_PARAM", "table is required for 'describe' action");
                        }
                        const result = await dolthubQuery(owner, dbName, `DESCRIBE \`${table}\``);
                        return createCodeModeResponse(
                            { database: args.database, table, columns: result.rows },
                            { meta: { action: "describe" } },
                        );
                    }

                    case "sample": {
                        if (!table) {
                            return createCodeModeError("MISSING_REQUIRED_PARAM", "table is required for 'sample' action");
                        }
                        const result = await dolthubQuery(owner, dbName, `SELECT * FROM \`${table}\` LIMIT 5`);
                        return createCodeModeResponse(
                            {
                                database: args.database,
                                table,
                                schema: result.schema,
                                rows: result.rows,
                                row_count: result.rows.length,
                            },
                            { meta: { action: "sample" } },
                        );
                    }

                    case "stats": {
                        const tablesResult = await dolthubQuery(owner, dbName, "SHOW TABLES");
                        const tableNames = tablesResult.rows.map((r) => String(Object.values(r)[0]));
                        const stats: Array<{ table: string; rows: number }> = [];
                        for (const t of tableNames) {
                            try {
                                const countResult = await dolthubQuery(
                                    owner, dbName,
                                    `SELECT COUNT(*) AS cnt FROM \`${t}\``,
                                );
                                stats.push({ table: t, rows: Number(countResult.rows[0]?.cnt ?? 0) });
                            } catch {
                                stats.push({ table: t, rows: -1 });
                            }
                        }
                        return createCodeModeResponse(
                            { database: args.database, tables: stats },
                            { meta: { action: "stats" } },
                        );
                    }
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return createCodeModeError("API_ERROR", `dolthub_discover failed: ${msg}`);
            }
        },
    );
}
