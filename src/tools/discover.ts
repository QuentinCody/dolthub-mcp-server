import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dolthubQuery, dolthubListRepos, dolthubRepoDetail, dolthubTableSchemas } from "../lib/http";
import {
    createCodeModeResponse,
    createCodeModeError,
} from "@bio-mcp/shared/codemode/response";
import { searchDatabases } from "../spec/database-index";

export function registerDiscover(server: McpServer): void {
    server.registerTool(
        "dolthub_discover",
        {
            title: "Discover DoltHub Databases",
            description:
                "Explore DoltHub repositories and their schemas.\n\n" +
                "Actions:\n" +
                "- search: Find databases by keyword from curated index (e.g. 'hospital pricing', 'housing', 'finance')\n" +
                "- repos: List/search repositories for an owner via live API. Use query param to filter.\n" +
                "- detail: Get repository metadata (size, stars, forks, description)\n" +
                "- tables: List all tables with full column schemas for a database\n" +
                "- sample: Preview first 5 rows of a table\n" +
                "- stats: Show row counts for all tables in a database",
            inputSchema: {
                action: z.enum(["search", "repos", "detail", "tables", "sample", "stats"]).describe(
                    "What to discover: 'search' finds databases by keyword, 'repos' lists/searches repos for an owner, " +
                    "'detail' gets repo metadata, 'tables' shows full schemas, 'sample' previews rows, 'stats' shows row counts",
                ),
                query: z.string().optional().describe(
                    "Search keyword — used by 'search' (curated index) and 'repos' (live API filter)",
                ),
                owner: z.string().optional().describe(
                    "DoltHub owner — required for 'repos', optional for 'detail'/'tables'/'sample'/'stats' (parsed from database param)",
                ),
                database: z.string().optional().describe(
                    "Database in owner/name format (e.g. 'dolthub/hospital-price-transparency-v3')",
                ),
                table: z.string().optional().describe(
                    "Table name — required for 'sample' action",
                ),
            },
        },
        async (args) => {
            try {
                switch (args.action) {
                    case "search": {
                        const results = searchDatabases(args.query ? String(args.query) : "");
                        return createCodeModeResponse(
                            { query: args.query ?? "", results, count: results.length },
                            { meta: { action: "search" } },
                        );
                    }

                    case "repos": {
                        const owner = args.owner ? String(args.owner) : "dolthub";
                        const query = args.query ? String(args.query) : undefined;
                        const repos = await dolthubListRepos(owner, query);
                        return createCodeModeResponse(
                            { owner, query, repositories: repos, count: repos.length },
                            { meta: { action: "repos" } },
                        );
                    }

                    case "detail": {
                        const { owner, dbName } = parseDatabase(args);
                        const detail = await dolthubRepoDetail(owner, dbName);
                        if (!detail) {
                            return createCodeModeError("NOT_FOUND", `Repository ${owner}/${dbName} not found`);
                        }
                        return createCodeModeResponse(detail, { meta: { action: "detail" } });
                    }

                    case "tables": {
                        const { owner, dbName, database } = parseDatabase(args);
                        const schemas = await dolthubTableSchemas(owner, dbName);
                        return createCodeModeResponse(
                            { database, tables: schemas, table_count: schemas.length },
                            { meta: { action: "tables" } },
                        );
                    }

                    case "sample": {
                        const { owner, dbName, database } = parseDatabase(args);
                        const table = args.table ? String(args.table) : undefined;
                        if (!table) {
                            return createCodeModeError("MISSING_REQUIRED_PARAM", "table is required for 'sample'");
                        }
                        const result = await dolthubQuery(owner, dbName, `SELECT * FROM \`${table}\` LIMIT 5`);
                        return createCodeModeResponse(
                            { database, table, schema: result.schema, rows: result.rows, row_count: result.rows.length },
                            { meta: { action: "sample" } },
                        );
                    }

                    case "stats": {
                        const { owner, dbName, database } = parseDatabase(args);
                        const schemas = await dolthubTableSchemas(owner, dbName);
                        const stats: Array<{ table: string; rows: number; columns: number }> = [];
                        for (const t of schemas) {
                            try {
                                const countResult = await dolthubQuery(owner, dbName, `SELECT COUNT(*) AS cnt FROM \`${t.table}\``);
                                stats.push({ table: t.table, rows: Number(countResult.rows[0]?.cnt ?? 0), columns: t.columns.length });
                            } catch {
                                stats.push({ table: t.table, rows: -1, columns: t.columns.length });
                            }
                        }
                        return createCodeModeResponse(
                            { database, tables: stats },
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

function parseDatabase(args: Record<string, unknown>): { owner: string; dbName: string; database: string } {
    const database = args.database ? String(args.database) : "";
    const parts = database.split("/");
    if (parts.length < 2) {
        throw new Error("database must be in owner/name format (e.g. 'dolthub/hospital-price-transparency-v3')");
    }
    return { owner: parts[0], dbName: parts.slice(1).join("/"), database };
}
