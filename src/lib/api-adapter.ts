import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { commercialRequestDecision } from "./commercial-profile";
import { dolthubQuery } from "./http";
import { dolthubV2Read } from "./v2";

/**
 * Code Mode API adapter for DoltHub.
 *
 * Path pattern: /{owner}/{database}
 * Required param: q (SQL query)
 * Optional param: ref (branch/tag/commit)
 *
 * Example: api.get('/dolthub/hospital-price-transparency-v3', { q: 'SELECT * FROM hospitals LIMIT 5' })
 *
 * A reselling caller (`licenseProfile: "commercial"`) gets the rule of
 * ./commercial-profile: each route names one database, and the database is
 * served only when its LICENSE.md is a license that permits commercial use.
 * The served result carries that license as `database_license`.
 */
export function createDoltHubApiFetch(token?: string): ApiFetchFn {
    const read = readDoltHub(token);
    return async (request) => {
        if (request.licenseProfile !== "commercial") return read(request);
        const decision = await commercialRequestDecision(request);
        if ("refusal" in decision) return decision.refusal;
        const result = await read(request);
        return { ...result, data: { ...(result.data as Record<string, unknown>), database_license: decision.license } };
    };
}

function readDoltHub(token?: string): ApiFetchFn {
    return async (request) => {
        if (request.path.startsWith("/api/")) {
            const result = await dolthubV2Read(request, token);
            const metadata = result.data._mcp as {sql?: {query_succeeded: boolean}};
            if (metadata.sql?.query_succeeded === false) throw Object.assign(new Error("DoltHub SQL query did not complete successfully; inspect native status, message, rows and warnings"), {status: result.status, data: result.data});
            return result;
        }
        if (request.method !== "GET" || request.body !== undefined) throw new Error("Legacy DoltHub query supports GET only");
        const path = request.path.startsWith("/") ? request.path.slice(1) : request.path;
        const parts = path.split("/");

        if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]{1,100}$/.test(part))) {
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
                provider: result,
            },
        };
    };
}
