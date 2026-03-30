import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

export const dolthubCatalog: ApiCatalog = {
    name: "DoltHub",
    baseUrl: "https://www.dolthub.com/api/v1alpha1",
    version: "v1alpha1",
    auth: "none",
    endpointCount: 1,
    notes:
        "- DoltHub is a Git-for-data platform hosting versioned SQL databases\n" +
        "- Query ANY public database: api.get('/{owner}/{database}', { q: 'SQL query' })\n" +
        "- SQL dialect: MySQL 8.0 — supports JOINs, CTEs, window functions, aggregations\n" +
        "- Max 1000 rows per query. Use LIMIT/OFFSET to paginate. Use aggregations to summarize.\n" +
        "- If truncated, response has truncated: true\n" +
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
        "STAGING: No auto-staging. If you need to re-query results, explicitly stage with db.stage(results, 'table_name').\n" +
        "Then use dolthub_query_data with the returned data_access_id to run SQL against the local copy.\n" +
        "\n" +
        "DISCOVERY: Use SHOW TABLES, DESCRIBE {table}, and SELECT * ... LIMIT 5 to explore unfamiliar databases.",
    endpoints: [
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
