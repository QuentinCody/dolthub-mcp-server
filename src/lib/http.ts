const DOLTHUB_API_BASE = "https://www.dolthub.com/api/v1alpha1";
const DOLTHUB_GRAPHQL = "https://www.dolthub.com/graphql";

/**
 * Execute a SQL query against a DoltHub database via the REST API.
 * Returns the parsed JSON response.
 */
export async function dolthubQuery(
    owner: string,
    database: string,
    sql: string,
    ref?: string,
): Promise<DoltHubQueryResponse> {
    const path = ref
        ? `${DOLTHUB_API_BASE}/${owner}/${database}/${ref}`
        : `${DOLTHUB_API_BASE}/${owner}/${database}`;

    const url = `${path}?q=${encodeURIComponent(sql)}`;

    const response = await fetch(url, {
        headers: { "User-Agent": "dolthub-mcp-server/1.0 (bio-mcp)" },
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`DoltHub API error: HTTP ${response.status} ${body.slice(0, 300)}`);
    }

    return response.json() as Promise<DoltHubQueryResponse>;
}

// ---------------------------------------------------------------------------
// GraphQL API — unofficial, no introspection available.
// All queries are probed defensively: if the schema changes, we catch the
// error and fall back to the REST SQL API where possible.
// ---------------------------------------------------------------------------

/**
 * Execute a GraphQL query against DoltHub's (unofficial) GraphQL endpoint.
 * Returns the parsed data or throws on error.
 */
async function gql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(DOLTHUB_GRAPHQL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "dolthub-mcp-server/1.0 (bio-mcp)",
        },
        body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
        throw new Error(`DoltHub GraphQL HTTP ${response.status}`);
    }

    const result = await response.json() as { data?: T; errors?: Array<{ message: string }> };
    if (result.errors?.length) {
        throw new Error(`DoltHub GraphQL: ${result.errors[0].message}`);
    }
    if (!result.data) {
        throw new Error("DoltHub GraphQL: empty response");
    }
    return result.data;
}

/**
 * List repositories for an owner, optionally filtered by keyword.
 * Uses the GraphQL `repos` query with `query` parameter for search.
 * Falls back gracefully if the GraphQL schema changes.
 */
export async function dolthubListRepos(
    owner: string,
    search?: string,
): Promise<DoltHubRepo[]> {
    try {
        const queryParam = search ? `, query: ${JSON.stringify(search)}` : "";
        const data = await gql<{
            repos: { list: Array<{ ownerName: string; repoName: string; description?: string }> };
        }>(`query { repos(ownerName: ${JSON.stringify(owner)}${queryParam}) { list { ownerName repoName description } } }`);
        return (data.repos?.list ?? []).map((r) => ({
            owner: r.ownerName,
            name: r.repoName,
            description: r.description ?? "",
        }));
    } catch {
        // GraphQL failed — no fallback for repo listing
        return [];
    }
}

/**
 * Get repository detail including size, stars, and forks.
 */
export async function dolthubRepoDetail(
    owner: string,
    database: string,
): Promise<DoltHubRepoDetail | null> {
    try {
        const data = await gql<{
            repo: {
                ownerName: string;
                repoName: string;
                description?: string;
                size?: number;
                visibility?: string;
                forkCount?: number;
                starCount?: number;
            };
        }>(`query { repo(ownerName: ${JSON.stringify(owner)}, repoName: ${JSON.stringify(database)}) { ownerName repoName description size visibility forkCount starCount } }`);
        const r = data.repo;
        if (!r) return null;
        return {
            owner: r.ownerName,
            name: r.repoName,
            description: r.description ?? "",
            size: r.size,
            visibility: r.visibility,
            forks: r.forkCount,
            stars: r.starCount,
        };
    } catch {
        return null;
    }
}

/**
 * Get table list with column schemas for a database via GraphQL.
 * Falls back to SHOW TABLES + DESCRIBE via REST SQL API.
 */
export async function dolthubTableSchemas(
    owner: string,
    database: string,
    ref = "main",
): Promise<DoltHubTableSchema[]> {
    try {
        const data = await gql<{
            tables: Array<{
                tableName: string;
                columns: Array<{ name: string; type: string; isPrimaryKey: boolean; constraints: Array<{ notNull: boolean }> }>;
            }>;
        }>(`query { tables(ownerName: ${JSON.stringify(owner)}, repoName: ${JSON.stringify(database)}, refName: ${JSON.stringify(ref)}) { tableName columns { name type isPrimaryKey constraints { notNull } } } }`);
        return (data.tables ?? []).map((t) => ({
            table: t.tableName,
            columns: (t.columns ?? []).map((c) => ({
                name: c.name,
                type: c.type,
                primaryKey: c.isPrimaryKey,
                notNull: c.constraints?.some((con) => con.notNull) ?? false,
            })),
        }));
    } catch {
        // Fallback to REST SQL API
        return dolthubTableSchemasFallback(owner, database);
    }
}

async function dolthubTableSchemasFallback(
    owner: string,
    database: string,
): Promise<DoltHubTableSchema[]> {
    const tablesResult = await dolthubQuery(owner, database, "SHOW TABLES");
    const tableNames = tablesResult.rows.map((r) => String(Object.values(r)[0]));
    const schemas: DoltHubTableSchema[] = [];
    for (const t of tableNames) {
        try {
            const desc = await dolthubQuery(owner, database, `DESCRIBE \`${t}\``);
            schemas.push({
                table: t,
                columns: desc.rows.map((r) => ({
                    name: String(r.Field ?? ""),
                    type: String(r.Type ?? ""),
                    primaryKey: r.Key === "PRI",
                    notNull: r.Null === "NO",
                })),
            });
        } catch {
            schemas.push({ table: t, columns: [] });
        }
    }
    return schemas;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DoltHubQueryResponse {
    query_execution_status: "Success" | "RowLimit" | "Error";
    query_execution_message: string;
    repository_owner: string;
    repository_name: string;
    commit_ref: string;
    sql_query: string;
    schema: Array<{ columnName: string; columnType: string }>;
    rows: Array<Record<string, unknown>>;
}

export interface DoltHubRepo {
    owner: string;
    name: string;
    description: string;
}

export interface DoltHubRepoDetail extends DoltHubRepo {
    size?: number;
    visibility?: string;
    forks?: number;
    stars?: number;
}

export interface DoltHubTableSchema {
    table: string;
    columns: Array<{
        name: string;
        type: string;
        primaryKey: boolean;
        notNull: boolean;
    }>;
}
