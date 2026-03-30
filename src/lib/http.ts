const DOLTHUB_API_BASE = "https://www.dolthub.com/api/v1alpha1";
const DOLTHUB_WEB_BASE = "https://www.dolthub.com";

/**
 * Execute a SQL query against a DoltHub database.
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

/**
 * Search DoltHub repositories via the discover page API.
 */
export async function dolthubSearch(query: string): Promise<DoltHubSearchResult[]> {
    const url = `${DOLTHUB_WEB_BASE}/api/v1alpha1/discover?q=${encodeURIComponent(query)}`;

    const response = await fetch(url, {
        headers: { "User-Agent": "dolthub-mcp-server/1.0 (bio-mcp)" },
    });

    if (!response.ok) {
        // Fallback: the discover API may not support search params.
        // Return empty rather than erroring.
        return [];
    }

    const data = await response.json() as Record<string, unknown>;
    // Response shape varies — extract repositories if present
    if (Array.isArray(data)) return data as DoltHubSearchResult[];
    if (data.repositories && Array.isArray(data.repositories)) {
        return data.repositories as DoltHubSearchResult[];
    }
    return [];
}

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

export interface DoltHubSearchResult {
    repository_name?: string;
    owner_name?: string;
    description?: string;
    [key: string]: unknown;
}
