import { getRequestLicenseProfile, type MaybeExtra } from "@bio-mcp/shared";
import {
    createCodeModeError,
    createCodeModeResponse,
} from "@bio-mcp/shared/codemode/response";
import type { McpServer } from "@bio-mcp/shared/mcp";
import { z } from "zod";
import { commercialDatabaseDecision, revisionRefusal, sqlRevisionReason, UNREAD_LISTED_LICENSE } from "../lib/commercial-profile";
import { dolthubListRepos, dolthubQuery, dolthubTableSchemas, quoteIdentifier, upstreamErrorSummary } from "../lib/http";
import { dolthubResponse } from "../lib/tool-result";
import { dolthubV2Read } from "../lib/v2";
import { searchDatabases } from "../spec/database-index";

type DiscoverEnv = { DOLTHUB_DATA_DO?: DurableObjectNamespace; DOLTHUB_TOKEN?: string };

const DISCOVER_DESCRIPTION =
    "Explore DoltHub repositories and their schemas.\n\n" +
    "Actions:\n" +
    "- search: Find databases by keyword from curated index (e.g. 'hospital pricing', 'housing', 'finance')\n" +
    "- repos: List/search repositories for an owner via live API. Use query param to filter.\n" +
    "- detail: Get repository metadata (size, stars, forks, description)\n" +
    "- tables: List all tables with full column schemas for a database\n" +
    "- sample: Preview first 5 rows of a table\n" +
    "- stats: Show row counts for all tables in a database";

const DISCOVER_INPUT_SCHEMA = {
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
};

type DiscoverArgs = {
    action: "search" | "repos" | "detail" | "tables" | "sample" | "stats";
    query?: string;
    owner?: string;
    database?: string;
    table?: string;
};

export function registerDiscover(server: McpServer, env?: DiscoverEnv): void {
    for (const toolName of ["dolthub_discover", "mcp_dolthub_discover"]) server.registerTool(
        toolName,
        { title: "Discover DoltHub Databases", description: DISCOVER_DESCRIPTION, inputSchema: DISCOVER_INPUT_SCHEMA },
        async (args, extra) => dolthubResponse(() => runDiscover(args, env, getRequestLicenseProfile(extra as MaybeExtra | undefined)), env ?? {}, toolName, extra, args),
    );
}

type DiscoverResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

/**
 * A reselling caller (see lib/commercial-profile): the listings `search` and
 * `repos` mark the license of each database as unknown; `detail`, `tables`,
 * `sample` and `stats` read one database and are served only under a license
 * that permits commercial use, with that license as `database_license`.
 */
export async function runDiscover(args: DiscoverArgs, env: DiscoverEnv | undefined, profile?: "commercial"): Promise<DiscoverResult> {
    if (profile !== "commercial") return runDiscoverAction(args, env);
    if (args.action === "search" || args.action === "repos") return withListedLicenses(await runDiscoverAction(args, env));
    const { owner, dbName } = parseDatabase(args);
    const decision = await commercialDatabaseDecision(owner, dbName);
    if ("refusal" in decision) return refusedResult(decision.refusal, `${owner}/${dbName}`);
    // Only the default branch whose license was read is served: the reads use its ref,
    // and a sample table name with a revision qualifier is refused.
    const { ref } = decision.license;
    const sampleReason = args.action === "sample" && args.table
        ? sqlRevisionReason(`SELECT * FROM ${quoteIdentifier(String(args.table))} LIMIT 5`) : undefined;
    if (sampleReason) return refusedResult(revisionRefusal(decision.license.database, ref, sampleReason), `${owner}/${dbName}`);
    const result: DiscoverResult = await runDiscoverAction(args, env, ref ?? undefined);
    const data = result.structuredContent?.data;
    if (!result.structuredContent || !isRecord(data)) return result;
    return { ...result, structuredContent: { ...result.structuredContent, data: { ...data, database_license: decision.license } } };
}

function refusedResult(refusal: { status: number; data: Record<string, unknown> }, database: string): DiscoverResult {
    const message = String(refusal.data.message);
    return { content: [{ type: "text", text: message }], isError: true,
        structuredContent: { success: false, error: { code: String(refusal.data.error), message, status: refusal.status }, database } };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function withListedLicenses(result: DiscoverResult): DiscoverResult {
    const data = result.structuredContent?.data;
    if (!result.structuredContent || !isRecord(data)) return result;
    const key = Array.isArray(data.results) ? "results" : Array.isArray(data.repositories) ? "repositories" : undefined;
    if (!key) return result;
    const listed = (data[key] as unknown[]).map(item => ({ ...(isRecord(item) ? item : { value: item }), database_license: UNREAD_LISTED_LICENSE }));
    return { ...result, structuredContent: { ...result.structuredContent, data: { ...data, [key]: listed } } };
}

/** `ref`: the branch to read; undefined reads the default branch (and `tables` asks GraphQL for "main"). */
async function runDiscoverAction(args: DiscoverArgs, env: DiscoverEnv | undefined, ref?: string) {
    switch (args.action) {
        case "search": return discoverSearch(args);
        case "repos": return await discoverRepos(args);
        case "detail": return await readDatabaseDetails(args, env);
        case "tables": return await discoverTables(args, ref);
        case "sample": return await discoverSample(args, ref);
        case "stats": return await discoverStats(args, ref);
    }
}

function discoverSearch(args: DiscoverArgs) {
    const results = searchDatabases(args.query ? String(args.query) : "");
    return createCodeModeResponse(
        { query: args.query ?? "", results, count: results.length },
        { meta: { action: "search" } },
    );
}

async function discoverRepos(args: DiscoverArgs) {
    const owner = args.owner ? String(args.owner) : "dolthub";
    const query = args.query ? String(args.query) : undefined;
    const repos = await dolthubListRepos(owner, query);
    return createCodeModeResponse(
        { owner, query, repositories: repos, count: repos.length },
        { meta: { action: "repos" } },
    );
}

async function discoverTables(args: DiscoverArgs, ref?: string) {
    const { owner, dbName, database } = parseDatabase(args);
    const schemas = await dolthubTableSchemas(owner, dbName, ref);
    const failedTables = schemas.filter(s => s.error).map(s => s.table);
    return markPartial(createCodeModeResponse(
        { database, tables: schemas, table_count: schemas.length,
          ...(failedTables.length ? { failed_tables: failedTables,
            note: `Column schema could not be read for ${failedTables.length} table(s); their empty column lists are not authoritative.` } : {}) },
        { meta: { action: "tables" } },
    ), failedTables.length > 0);
}

async function discoverSample(args: DiscoverArgs, ref?: string) {
    const { owner, dbName, database } = parseDatabase(args);
    const table = args.table ? String(args.table) : undefined;
    if (!table) {
        return createCodeModeError("MISSING_REQUIRED_PARAM", "table is required for 'sample'");
    }
    const result = await dolthubQuery(owner, dbName, `SELECT * FROM ${quoteIdentifier(table)} LIMIT 5`, ref);
    return createCodeModeResponse(
        { database, table, schema: result.schema, rows: result.rows, row_count: result.rows.length },
        { meta: { action: "sample" } },
    );
}

async function discoverStats(args: DiscoverArgs, ref?: string) {
    const { owner, dbName, database } = parseDatabase(args);
    const stats = await readTableStats(owner, dbName, ref);
    const failedTables = stats.filter(s => s.error).map(s => s.table);
    return markPartial(createCodeModeResponse(
        { database, tables: stats,
          ...(failedTables.length ? { failed_tables: failedTables,
            note: `Row count or column schema could not be read for ${failedTables.length} table(s); null values are unknown, not zero.` } : {}) },
        { meta: { action: "stats" } },
    ), failedTables.length > 0);
}

async function readDatabaseDetails(args: DiscoverArgs, env: DiscoverEnv | undefined) {
  const { owner, dbName } = parseDatabase(args);
  const result = await dolthubV2Read({ method: "GET", path: `/api/v2/databases/${owner}/${dbName}` }, env?.DOLTHUB_TOKEN);
  const native = result.data.data as Record<string, unknown>;
  return createCodeModeResponse({
    ...native, size: native.size_bytes, forks: native.fork_network_count, stars: native.star_count,
    provider: result.data
  }, { meta: { action: "detail", api_version: "v2" } });
}

type UpstreamError = { message: string; status?: number };
type TableStat = { table: string; rows: number | null; columns: number | null; error?: { rows?: UpstreamError; columns?: UpstreamError } };

async function readTableStats(owner: string, dbName: string, ref?: string) {
  const schemas = await dolthubTableSchemas(owner, dbName, ref);
  const stats: TableStat[] = [];
  for (const t of schemas) {
    const columns = t.error ? null : t.columns.length;
    let rows: number | null = null;
    let rowsError: UpstreamError | undefined;
    try {
      const countResult = await dolthubQuery(owner, dbName, `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(t.table)}`, ref);
      rows = Number(countResult.rows[0]?.cnt ?? 0);
    } catch (err) {
      rowsError = upstreamErrorSummary(err);
    }
    const error = rowsError || t.error ? { ...(rowsError ? { rows: rowsError } : {}), ...(t.error ? { columns: t.error } : {}) } : undefined;
    stats.push({ table: t.table, rows, columns, ...(error ? { error } : {}) });
  }
  return stats;
}

/** Flag a discovery result as partial so dolthubResponse reports it with isError/success:false. */
function markPartial<R extends { structuredContent?: object }>(result: R, partial: boolean): R {
  return partial ? { ...result, structuredContent: { ...result.structuredContent, disposition: "partial" } } : result;
}

function parseDatabase(args: DiscoverArgs): { owner: string; dbName: string; database: string } {
    const database = args.database ? String(args.database) : "";
    const parts = database.split("/");
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]{1,100}$/.test(part))) {
        throw new Error("database must be in owner/name format (e.g. 'dolthub/hospital-price-transparency-v3')");
    }
    return { owner: parts[0], dbName: parts.slice(1).join("/"), database };
}
