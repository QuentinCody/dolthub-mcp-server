import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

import { v2Endpoints, v2Workflows } from "./v2";

export const dolthubCatalog: ApiCatalog = {
    name: "DoltHub",
    baseUrl: "https://www.dolthub.com/api/v1alpha1",
    version: "v1alpha1 + v2",
    auth: "none",
    endpointCount: 8,
    notes:
        "- DoltHub is a Git-for-data platform hosting versioned SQL databases\n" +
        "- V2 read/discovery routes use /api/v2/databases/{owner}/{database}; legacy /{owner}/{database} remains supported. Public reads are anonymous; optional DOLTHUB_TOKEN is Worker-scoped.\n" +
        "- V2 retains {data, meta} plus _mcp provenance/continuation. SQL status may be error/timeout/row_limit even on HTTP 200. Preserve rows as arrays and numeric cells as strings.\n" +
        "- Query-level non-success produces an MCP error with native HTTP 200 and full result under __api_error.data. Partial rows, columns and warnings remain recoverable. Discovery counts and SQL samples do not prove database completeness.\n" +
        "- Native reads on 2026-10-04 rejected direct commit-hash refs in both v2 and v1alpha1. Use a discovered branch for the connection plus explicit AS OF commit clauses on each table/schema read where supported. Views use their current definition with historical table rows; preserve the exact SQL and do not claim all queries are atomically pinned.\n" +
        "- Query ANY public database: api.get('/{owner}/{database}', { q: 'SQL query' })\n" +
        "- SQL dialect: MySQL 8.0 — supports JOINs, CTEs, window functions, aggregations\n" +
        "- Max 1000 rows per query. Use LIMIT/OFFSET to paginate. Use aggregations to summarize.\n" +
        "- Legacy truncation uses truncated: true; v2 uses native status: row_limit and _mcp.sql.truncated.\n" +
        "- Optional ref param for branch/tag/commit: api.get('/{owner}/{db}', { q: '...', ref: 'branch-name' })\n" +
        "- Use dolthub_discover to find databases and inspect their schemas before querying\n" +
        "\n" +
        "NOTABLE PUBLIC DATABASES:\n" +
        "- dolthub/hospital-price-transparency-v3: 296M hospital prices by payer, CPT code. Tables: hospitals (6K), prices (296M)\n" +
        "- dolthub/transparency-in-coverage: 2.7M insurance negotiated rates. Tables: in_network, provider_groups\n" +
        "- dolthub/us-housing-prices: 87M property sales. Tables: sales, states\n" +
        "- dolthub/us-businesses: 21M US businesses. Tables: businesses, business_types, naics, sic\n" +
        "- dolthub/options: 71M options chains with greeks. Tables: option_chain, volatility_history\n" +
        "- dolthub/irs-soi: 1.2M IRS income stats by zip. Tables: agi_by_zip, column_mappings\n" +
        "- dolthub/stock-tickers: 806K stock prices. Tables: prices, symbols\n" +
        "- dolthub/corona-virus: COVID-19 data with demographics. 26 tables.\n" +
        "\n" +
        "STAGING: Responses above 30 KiB auto-stage. Inspect staged handles with query/schema tools; db.stage is also available.\n" +
        "Then use dolthub_query_data with the returned data_access_id to run SQL against the local copy.\n" +
        "\n" +
        "DISCOVERY: Use SHOW TABLES, DESCRIBE {table}, and SELECT * ... LIMIT 5 to explore unfamiliar databases.",
    workflows: v2Workflows,
    endpoints: [
        ...v2Endpoints,
        {
            method: "GET",
            path: "/{owner}/{database}",
            summary:
                "Execute a SQL query against any public DoltHub database. Returns rows, schema, and truncation status.",
            category: "query",
            pathParams: [
                { name: "owner", type: "string", required: true, description: "Repository owner (e.g. 'dolthub')" },
                { name: "database", type: "string", required: true, description: "Repository/database name (e.g. 'hospital-price-transparency-v3')" },
            ],
            queryParams: [
                { name: "q", type: "string", required: true, description: "SQL query to execute (MySQL 8.0 dialect)" },
                { name: "ref", type: "string", required: false, description: "Branch, tag, or commit hash (default: main/master)" },
            ],
        },
    ],
};
