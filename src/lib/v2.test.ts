import {afterEach, expect, it, vi} from "vitest";
import {v2Workflows} from "../spec/v2";
import {createDoltHubApiFetch} from "./api-adapter";

const api = createDoltHubApiFetch();
const path = "/api/v2/databases/dolthub/us-jails";
const commit = "vt1u8gdsovtj0qq2qmd6he7n5o4mq2qm";
// Synthetic contract fixtures; not a live provider capture.
const sqlData = {columns: [{name: "id", type: "BIGINT", is_primary_key: true}, {name: "id", type: "TEXT"}], rows: [["9007199254740993", null], ["001", "<binary>"]], status: "success", warnings: [{code: "FIXTURE", message: "retain warning"}]};
const query = {method: "GET" as const, path: `${path}/sql`, params: {q: "SELECT * FROM fixture LIMIT 2", ref: commit, limit: 2}};
function mock(value: unknown = {data: sqlData}) { vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Response(JSON.stringify(value)))); }
afterEach(() => vi.unstubAllGlobals());
it("preserves ordered rows, duplicate column names, strings, nulls, warnings and commit selection", async () => {
  mock(); const result = await api(query);
  expect(result.data).toMatchObject({data: sqlData, _mcp: {sql: {query_succeeded: true, requested_commit_sha: commit, resolved_commit_sha: null}, provenance: {api_version: "v2", response_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)}}});
  const [url, init] = vi.mocked(fetch).mock.calls[0]; expect(new URL(String(url)).searchParams.get("ref")).toBe(commit); expect(new Headers(init?.headers).has("Authorization")).toBe(false); expect(init?.redirect).toBe("manual");
});
it("supports body-encoded read SQL and does not put long queries in the URL", async () => {
  mock(); const q = `SELECT '${"a".repeat(20000)}'`;
  await api({method: "POST", path: `${path}/sql`, body: {ref: "feature/slash", q}});
  const [url, init] = vi.mocked(fetch).mock.calls[0]; expect(String(url)).toBe(`https://www.dolthub.com${path}/sql`); expect(init?.method).toBe("POST"); expect(JSON.parse(String(init?.body))).toMatchObject({ref: "feature/slash", q, limit: 1000});
});
it.each(["error", "timeout", "row_limit", "not_workspace"])("preserves HTTP 200 SQL condition %s without labeling it successful", async status => {
  mock({data: {...sqlData, status, message: "provider condition"}});
  await expect(api(query)).rejects.toMatchObject({status: 200, data: {data: {status, message: "provider condition"}, _mcp: {sql: {query_succeeded: false, truncated: status === "row_limit"}}}});
});
it("does not equate a branch name with a resolved commit", async () => { mock(); expect((await api({...query, params: {...query.params, ref: "main"}})).data).toMatchObject({_mcp: {sql: {requested_commit_sha: null, resolved_commit_sha: null}}}); });
it.each(["branches", "tags", "releases"])("preserves %s pages and safely encodes opaque cursors", async resource => {
  const data = [{name: "release", commit_sha: commit, description: "native context"}]; mock({data, meta: {next_page_token: "opaque&next=+?", future: true}});
  const result = await api({method: "GET", path: `${path}/${resource}`, params: {page_token: "prior/+=?"}});
  expect(result.data).toMatchObject({data, meta: {future: true}, _mcp: {next_request: {path: `${path}/${resource}`, params: {page_token: "opaque&next=+?"}}, atomic_snapshot_verified: false}});
  expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).searchParams.get("page_token")).toBe("prior/+=?");
});
it.each([undefined, ""])("accepts exhausted cursor %j without asserting an atomic snapshot", async next_page_token => {
  mock({data: [], meta: {next_page_token}}); expect((await api({method: "GET", path: `${path}/tags`})).data).toMatchObject({_mcp: {next_request: null, atomic_snapshot_verified: false}});
});
it("preserves database/fork lineage and non-paginated forks", async () => {
  mock({data: {owner: "dolthub", name: "us-jails", parent: {owner: "source", name: "us-jails"}, last_write_at: "2026-01-01T00:00:00Z"}});
  expect((await api({method: "GET", path})).data).toMatchObject({data: {parent: {owner: "source"}, last_write_at: "2026-01-01T00:00:00Z"}});
  mock({data: []}); expect((await api({method: "GET", path: `${path}/forks`})).data).toMatchObject({data: [], _mcp: {next_request: null}});
});
it.each(["/api/v2/databases", `${path}/sql-writes`, `${path}/imports`, `${path}/pulls/1/merge`, "/api/v2/databases/dolthub/../x", `${path}?token=x`, "https://evil.test/api/v2/databases/a/b"])("rejects unsupported routes %s before any request", async path => {
  mock(); await expect(api({method: "POST", path, body: {q: "SELECT 1"}})).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it.each(["branches", "tags", "releases", "forks"])("does not expose %s creation", async resource => {
  mock(); await expect(api({method: "POST", path: `${path}/${resource}`, body: {name: "new"}})).rejects.toThrow("Only GET"); expect(fetch).not.toHaveBeenCalled();
});
it.each([{ref: undefined}, {q: ""}, {limit: 1001}, {timeout_ms: 60001}, {page_token: "x"}, {token: "secret"}])("rejects missing/unsupported SQL controls %#", async changes => {
  mock(); await expect(api({...query, params: {...query.params, ...changes}})).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it("rejects undocumented pagination knobs and repeating cursors", async () => {
  mock({data: [], meta: {next_page_token: "same"}});
  await expect(api({method: "GET", path: `${path}/branches`, params: {page_size: 1}})).rejects.toThrow("Unsupported");
  await expect(api({method: "GET", path: `${path}/branches`, params: {page_token: "same"}})).rejects.toThrow("advance");
});
it("scopes optional tokens to each v2 adapter and preserves bounded problem details", async () => {
  const token = "fixture-private-token";
  const privateApi = createDoltHubApiFetch(token);
  mock(); await privateApi(query); await api(query);
  expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
  expect(new Headers(vi.mocked(fetch).mock.calls[1][1]?.headers).has("Authorization")).toBe(false);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({type: "about:blank", title: "Missing", status: 404, code: "NOT_FOUND", request_id: "req-1", detail: token, huge: "x".repeat(5000)}), {status: 404})));
  await expect(privateApi(query)).rejects.toMatchObject({status: 404, data: {problem: {code: "NOT_FOUND", request_id: "req-1", detail: "[REDACTED]"}, http_status: 404}});
});
it("bounds JSON reads and sanitizes network/non-JSON failures", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("secret")) .mockResolvedValueOnce(new Response("secret", {status: 500})).mockResolvedValueOnce(new Response("x".repeat(4*1024*1024+1))).mockResolvedValueOnce(new Response("not-json")));
  await expect(api(query)).rejects.toThrow("request failed"); await expect(api(query)).rejects.toMatchObject({message: "DoltHub v2 HTTP 500", data: {problem: {}}}); await expect(api(query)).rejects.toThrow("byte limit"); await expect(api(query)).rejects.toThrow("invalid JSON");
});
it.each([{data: {...sqlData, status: "unknown"}}, {data: {...sqlData, rows: [[1, null]]}}, {data: {...sqlData, rows: [["one-cell"]]}}, {meta: {}}])("rejects malformed result contract %#", async value => { mock(value); await expect(api(query)).rejects.toThrow(); });
it("keeps the legacy SQL envelope and encodes revision segments", async () => {
  mock({query_execution_status: "RowLimit", repository_owner: "dolthub", repository_name: "us-jails", commit_ref: commit, schema: [], rows: [{value: "001"}]});
  const result = await api({method: "GET", path: "/dolthub/us-jails", params: {q: "SELECT 1", ref: "feature/slash"}});
  expect(result.data).toMatchObject({rows: [{value: "001"}], truncated: true, ref: commit}); expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/api/v1alpha1/dolthub/us-jails/feature%2Fslash?");
});
const run = (index: number, api: unknown) => new Function("api", `return (async()=>{${v2Workflows[index].code}})()`)(api);
it("release recipe returns continuation after three pages and detects cycles", async () => {
  const page = (token: string) => ({data: [], _mcp: {next_request: {params: {page_token: token}}}});
  const get = vi.fn().mockResolvedValueOnce(page("a")).mockResolvedValueOnce(page("b")).mockResolvedValueOnce(page("c"));
  expect(await run(0, {get})).toMatchObject({next_request: {params: {page_token: "c"}}, complete: false});
  get.mockReset().mockResolvedValueOnce(page("a")).mockResolvedValueOnce(page("b")).mockResolvedValueOnce(page("a")); expect(await run(0, {get})).toMatchObject({cursor_cycle: true, complete: false});
});
it.each([{__staged: true, data_access_id: "fixture"}, {__api_error: true}, {__stage_error: true}])("release recipe preserves pending page %#", async handle => {
  const get = vi.fn().mockResolvedValue(handle); expect(await run(0, {get})).toMatchObject({pending_page: handle, complete: false}); expect(get).toHaveBeenCalledTimes(1);
});
it("commit recipe uses discovered hash and retains evidence and query status", async () => {
  const local = {get: vi.fn().mockResolvedValue({data: [{name: "main", head_commit_sha: commit}]}), post: vi.fn().mockResolvedValue({data: {status: "timeout"}})};
  expect(await run(1, local)).toMatchObject({selected_commit: commit, revision_method: "SQL AS OF", connection_ref: "main", result: {data: {status: "timeout"}}}); expect(local.post).toHaveBeenCalledWith(`${path}/sql`, expect.objectContaining({ref: "main", q: `SHOW TABLES AS OF '${commit}'`}));
  local.get.mockResolvedValue({data: []}); local.post.mockClear(); expect(await run(1, local)).toHaveProperty("query_skipped"); expect(local.post).not.toHaveBeenCalled();
});
