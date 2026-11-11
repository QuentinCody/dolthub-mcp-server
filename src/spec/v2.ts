import type { ApiEndpoint, ParamDef, WorkflowRecipe } from "@bio-mcp/shared/codemode/catalog";

const path = "/api/v2/databases/{owner}/{database}";
const pathParams: ParamDef[] = [
  {name: "owner", type: "string", required: true, description: "DoltHub owner"},
  {name: "database", type: "string", required: true, description: "DoltHub database name"},
];
const sqlParams: ParamDef[] = [
  {name: "ref", type: "string", required: true, description: "Discovered branch/tag. Although documented, commit-hash refs were rejected by native reads on 2026-10-04; use explicit SQL AS OF commit clauses for supported snapshot reads."},
  {name: "q", type: "string", required: true, description: "Read-only SQL; rows remain ordered arrays matching columns. Use explicit ordering for samples."},
  {name: "limit", type: "number", required: false, description: "Local row bound 1–1000; server also caps rows. No SQL cursor pagination.", default: 1000},
  {name: "timeout_ms", type: "number", required: false, description: "SQL timeout 1–60000 ms", default: 30000},
];
export const v2Endpoints: ApiEndpoint[] = [
  {method: "GET", path, pathParams, summary: "Get v2 database metadata including last-write, visibility and fork lineage", category: "v2-discovery"},
  ...["branches", "tags", "releases", "forks"].map(resource => ({method: "GET" as const, path: `${path}/${resource}`, pathParams,
    summary: `List v2 ${resource}; preserve native commit IDs, dates and metadata`, category: "v2-discovery",
    queryParams: resource === "forks" ? [] : [{name: "page_token", type: "string" as const, required: false, description: "Opaque meta.next_page_token from prior page; absent/empty means exhausted. No page-size parameter."}],
  })),
  {method: "GET", path: `${path}/sql`, pathParams, queryParams: sqlParams, summary: "Read-only SQL at an explicit revision via DoltHub v2", category: "v2-query"},
  {method: "POST", path: `${path}/sql`, pathParams, body: {contentType: "application/json", description: "{ref: string, q: string, limit?: number (1–1000), timeout_ms?: number (1–60000)}. Body-encoded read, including long SQL. This endpoint does not execute writes."}, summary: "Body-encoded read-only SQL at an explicit revision", category: "v2-query"},
];
export const v2Workflows: WorkflowRecipe[] = [
  {title: "Discover DoltHub releases with bounded cursor continuation", keywords: ["v2", "release", "cursor", "revision", "pagination"], description: "Retrieve at most three pages and return an explicit continuation. Preserve native release commit IDs, metadata and staged handles; cursor exhaustion alone does not prove a consistent snapshot.", code: `const path = "/api/v2/databases/dolthub/us-jails/releases";
const pages = [];
const seen = new Set();
let params = {};
for (let i = 0; i < 3; i++) {
  const page = await api.get(path, params);
  if (page.__staged || page.__api_error || page.__stage_error) return {pages, pending_page: page, complete: false};
  pages.push(page);
  const next = page._mcp.next_request;
  if (!next) return {pages, cursor_exhausted: true, atomic_snapshot_verified: false};
  if (seen.has(next.params.page_token)) return {pages, cursor_cycle: true, complete: false};
  seen.add(next.params.page_token);
  params = next.params;
}
return {pages, next_request: {method: "GET", path, params}, complete: false};`},
  {title: "Pin DoltHub SQL schema inspection with AS OF a discovered commit", keywords: ["v2", "SQL", "commit", "schema", "reproducible"], description: "Find main in the returned branch page, connect via that branch and use its head commit in SHOW TABLES AS OF. Native commit-hash ref requests were rejected on 2026-10-04. If main is absent, retain continuation instead of guessing. AS OF snapshots committed state; success does not imply all rows were retrieved.", code: `const path = "/api/v2/databases/dolthub/us-jails";
const branches = await api.get(path + "/branches");
if (branches.__staged || branches.__api_error || branches.__stage_error) return branches;
const branch = branches.data.find(b => b.name === "main");
if (!branch || !/^[0-9a-v]{32}$/.test(branch.head_commit_sha)) return {branches, query_skipped: "Inspect remaining branches and select a valid commit"};
const result = await api.post(path + "/sql", {ref: branch.name, q: "SHOW TABLES AS OF '" + branch.head_commit_sha + "'", limit: 100, timeout_ms: 30000});
return {branches, selected_commit: branch.head_commit_sha, revision_method: "SQL AS OF", connection_ref: branch.name, result};`},
];
