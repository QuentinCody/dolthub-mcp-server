# Dolthub MCP Server

This is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It lets MCP clients (Claude Desktop, Claude Code, Continue, etc.) query the upstream Dolthub API in natural language. It is one of 100+ servers in the [Bio MCP](../../README.md) monorepo.

## Connect

The configured production endpoint is:

```
https://dolthub-mcp-server.quentincody.workers.dev/mcp
```

Add it to your MCP client (Claude Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "dolthub": {
      "command": "npx",
      "args": ["mcp-remote", "https://dolthub-mcp-server.quentincody.workers.dev/mcp"]
    }
  }
}
```

For local development the server runs at `http://localhost:8868/mcp` (start it with `./scripts/dev-servers.sh dolthub`):

```json
{
  "mcpServers": {
    "dolthub-local": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8868/mcp"]
    }
  }
}
```

## Tools

- `dolthub_search` — discover available API operations (Code Mode catalog search)
- `dolthub_execute` — **Code Mode**: write JavaScript in a V8 isolate (`api.get()` / `api.post()` / `searchSpec()`) instead of issuing tool calls one by one
- `dolthub_query_data` — run SQL over large responses auto-staged into a per-session SQLite database
- `dolthub_get_schema` — inspect the inferred schema of a staged dataset
- `dolthub_discover`

Large responses (>30KB) are auto-staged into a queryable SQLite database; the tools return a `data_access_id` you can query with SQL.

Every tool returns both a human-readable `content` summary and a structured `structuredContent` payload.

## Development

```bash
./scripts/dev-servers.sh dolthub            # run locally (port 8868)
pnpm --filter dolthub-mcp-server run deploy   # deploy to Cloudflare Workers
```

See [`docs/adding-mcp-servers.md`](../../docs/adding-mcp-servers.md) and the root [README](../../README.md) for the full architecture (Code Mode, staging, portals).

---



## V2 read and discovery support

Reviewed the [July 9, 2026 announcement](https://www.dolthub.com/blog/2026-07-09-dolthub-api-v2/) and [v2 contract](https://www.dolthub.com/docs/products/dolthub/api/v2/database/), with native and local Worker acceptance on October 4, 2026. V1alpha1 remains supported. This local addition has not been deployed.

The catalog adds database metadata, branches, tags, releases, forks, and GET/POST read-only SQL under `/api/v2/databases/{owner}/{database}`. It exposes seven v2 operations plus the existing legacy SQL alias. POST `/sql` encodes long read queries in JSON; write/version-control endpoints are not exposed. Public reads are anonymous. Optional Worker secret `DOLTHUB_TOKEN` supplies bearer authentication only to v2 requests.

V2 responses retain native `{data, meta}` and add `_mcp` request/provenance, SQL-status and continuation metadata. Branch/tag/release lists use opaque `page_token`; forks have no pagination argument in the current contract, and their order varied between native reads. SQL has no cursor pagination. Local SQL limits are 1–1000 rows and 1–60000 ms; requests have a 70-second deadline, response bodies a 4 MiB cap and a 15-second read deadline. Partial responses, malformed JSON and invalid UTF-8 fail explicitly. The release recipe reads at most three pages, detects cursor cycles and returns continuation. Staged pages must be inspected before continuing.

SQL rows remain arrays matching ordered columns, so duplicate column names cannot overwrite cells. Numeric strings, nulls, binary placeholders, warnings and query statuses remain intact. HTTP 200 can contain SQL error, timeout or row-limit status. These non-success conditions produce an MCP error with native HTTP status 200 and the complete envelope under `__api_error.data`; partial rows remain recoverable. `_mcp.sql.query_succeeded` is true only for provider status `success`; this does not establish full database coverage. Native checks preserved two columns named `code`, the values `"001"` and `"9007199254740993"`, and a typed SQL NULL.

The live API rejected a discovered commit hash as `ref` in both v2 and v1alpha1, despite the v2 documentation. The schema recipe therefore connects through a discovered branch and sends `SHOW TABLES AS OF '<commit>'`. Native `SHOW TABLES AS OF` and `SELECT ... FROM naics AS OF '<commit>'` succeeded. The adapter does not silently rewrite rejected refs. For row queries, qualify each relevant table explicitly; [AS OF uses committed snapshots, and views retain their current definition](https://www.dolthub.com/docs/sql-reference/version-control/querying-history/). Record the exact SQL and selected commit. Resolved commit remains unknown in generic query metadata because QueryResult does not report it. Branch/tag names, release dates and retrieval time do not establish immutable revisions or historical availability.

`dolthub_discover` detail now uses v2 while retaining its previous named fields and attaching the complete v2 envelope as `provider`. Other legacy discovery actions retain their current GraphQL/SQL implementations; v2 does not provide an owner-wide repository list in the inspected contract. All five tool families have both `dolthub_*` and `mcp_dolthub_*` aliases. Code Mode and hand-built discovery stage large results; missing storage yields an error rather than an oversized response.

Problem responses preserve complete native fields and received text within the body cap, including extension fields, code and request ID. Configured bearer-token text is redacted if echoed. Native success envelopes carry source URL, request parameters, retrieval time and SHA-256 of decoded response text after credential redaction. No automatic retry or write fallback occurs. Failed GraphQL repository discovery returns an error rather than an empty list, and legacy schema fallback retains an explicitly requested revision.

Every tool response carries a verifiable citation; composed responses above 30 KiB stage intact. Use `get_schema` to discover projected tables: `sql_rows` retains positional `c0`, `c1`, … cells and their original JSON; `query_columns` retains ordered schema; `response_context` retains status, warnings, request/revision and continuation evidence. `resources` holds v2 discovery rows. The `payloads` table retains the complete source envelope. Numeric strings remain TEXT in SQLite.

Local behavioral tests cover routing, method restrictions, legacy compatibility, cursor handling, SQL states/precision, credential isolation, full errors and real SQLite staging. October 4 acceptance passed 76 local MCP calls against native public data, including 1,000 SQL rows, typed cells, discovery, both recipes, transport/query errors and full-result citation recovery. The live contract also passes. Private access, nonempty release/tag pages, actual cursor traversal and BLOB payload samples remain unverified; no credentials or backend were provisioned. Receipts and exact scope are recorded in `scratch/2026-10-04-dolthub/verification.json` and the audit tracker.

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from DoltHub and stays under the terms of that source: Per-database licenses.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
