import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { dolthubQuery } from "./http";

/**
 * Code Mode API adapter for DoltHub.
 *
 * Path pattern: /{owner}/{database}
 * Required param: q (SQL query)
 * Optional param: ref (branch/tag/commit)
 *
 * Example: api.get('/dolthub/hospital-price-transparency-v3', { q: 'SELECT * FROM hospitals LIMIT 5' })
 */
export function createDoltHubApiFetch(): ApiFetchFn {
    return async (request) => {
        const path = request.path.startsWith("/") ? request.path.slice(1) : request.path;
        const parts = path.split("/");

        if (parts.length < 2) {
            const error = new Error(
                "Path must be /{owner}/{database}. Example: /dolthub/hospital-price-transparency-v3",
            ) as Error & { status: number; data: unknown };
            error.status = 400;
            error.data = { hint: "Use api.get('/{owner}/{database}', { q: 'SELECT ...' })" };
            throw error;
        }

        const owner = parts[0];
        const database = parts[1];
        const sql = String(request.params?.q || "");
        const ref = request.params?.ref ? String(request.params.ref) : undefined;

        if (!sql) {
            const error = new Error(
                "Missing 'q' parameter. Pass a SQL query: api.get('/{owner}/{database}', { q: 'SELECT ...' })",
            ) as Error & { status: number; data: unknown };
            error.status = 400;
            error.data = { hint: "q parameter with SQL query is required" };
            throw error;
        }

        const result = await dolthubQuery(owner, database, sql, ref);

        if (result.query_execution_status === "Error") {
            const error = new Error(
                `DoltHub SQL error: ${result.query_execution_message}`,
            ) as Error & { status: number; data: unknown };
            error.status = 400;
            error.data = result;
            throw error;
        }

        // Return rows directly with metadata
        return {
            status: 200,
            data: {
                rows: result.rows,
                row_count: result.rows.length,
                truncated: result.query_execution_status === "RowLimit",
                schema: result.schema,
                database: `${result.repository_owner}/${result.repository_name}`,
                ref: result.commit_ref,
            },
        };
    };
}
