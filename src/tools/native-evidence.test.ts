import { verifyCitationEnvelope } from "@bio-mcp/shared";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));

import { fixture, recover } from "./staging-fixture";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function invoke(f: ReturnType<typeof fixture>, name: string, args: Record<string, unknown>, failed = false) {
  const result = await f.tools[name].handler(args, {});
  expect(result.isError === true, JSON.stringify(result).slice(0, 500)).toBe(failed);
  expect(result.content.length).toBeGreaterThan(0);
  const sc = result.structuredContent;
  const id = sc.staged ? sc.data_access_id : sc.data?.__staged ? sc.data.data_access_id : undefined;
  const staged = id ? await recover(f, id, "") : undefined;
  const proof = await verifyCitationEnvelope({ citation: sc._meta?.citation, structuredContent: sc, toolArguments: args,
    ...(staged ? { materialized: { value: staged } } : {}) });
  expect(proof.verification).toMatchObject({ query: "verified", result: "verified" });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(30720);
  return { sc, id, data: sc.staged ? staged.structuredContent.data : sc.data?.__staged ? staged : sc.data };
}

it.each(["", "mcp_"])("verifies all %s aliases, argument hashes and error envelopes", async prefix => {
  const f = fixture();
  try {
    await invoke(f, `${prefix}dolthub_search`, { query: "revision" });
    await invoke(f, `${prefix}dolthub_discover`, { action: "search", query: "hospital" });
    await invoke(f, `${prefix}dolthub_discover`, { action: "detail", database: "invalid" }, true);
    await invoke(f, `${prefix}dolthub_execute`, { code: "return {value:'001'};" });
    await invoke(f, `${prefix}dolthub_execute`, { code: "" }, true);
    await invoke(f, `${prefix}dolthub_query_data`, { data_access_id: "missing", sql: "SELECT * FROM missing" }, true);
    await invoke(f, `${prefix}dolthub_get_schema`, { data_access_id: "missing" });
  } finally { f.close(); }
});

it("retains duplicate column names, exact numeric strings and NULL in real SQL staging", async () => {
  const f = fixture();
  const data = { columns: [{ name: "code", type: "VARCHAR(3)" }, { name: "code", type: "DECIMAL(20,0)" }, { name: "absent", type: "VARCHAR(1)" }],
    rows: [["001", "9007199254740993", null]], status: "success", warnings: ["α😀".repeat(7000)] };
  vi.stubGlobal("fetch", async () => Response.json({ data }));
  try {
    const result = await invoke(f, "dolthub_execute", { code: 'return await api.get("/api/v2/databases/dolthub/example/sql",{ref:"master",q:"SELECT typed_cells"});' });
    expect(result.data.data).toEqual(data); expect(result.id).toBeTruthy();
    const rows = await invoke(f, "mcp_dolthub_query_data", { data_access_id: result.id, sql: "SELECT c0,c1,c2,typeof(c1) AS kind,cells FROM sql_rows" });
    expect(rows.data.rows).toEqual([{ c0: "001", c1: "9007199254740993", c2: null, kind: "text", cells: JSON.stringify(data.rows[0]) }]);
    const columns = await invoke(f, "dolthub_query_data", { data_access_id: result.id, sql: "SELECT native_json FROM query_columns ORDER BY source_index" });
    expect(columns.data.rows.map((r: {native_json: string}) => JSON.parse(r.native_json))).toEqual(data.columns);
    expect(result.sc._meta.completeness.complete).toBe(false);
  } finally { f.close(); }
});

it("retains large native query failures and partial rows instead of reporting success", async () => {
  const f = fixture(); const data = { status: "row_limit", columns: [{ name: "id", type: "TEXT" }], rows: [["001"]], message: "α".repeat(30000), warnings: ["limited"] };
  vi.stubGlobal("fetch", async () => Response.json({ data }));
  try {
    const result = await invoke(f, "dolthub_execute", { code: 'return await api.get("/api/v2/databases/dolthub/example/sql",{ref:"master",q:"SELECT id FROM fixture"});' }, true);
    expect(result.data).toMatchObject({ __api_error: true, status: 200 });
    const native = result.data.data.__staged ? await recover(f, result.data.data.data_access_id, "") : result.data.data;
    expect(native.data).toEqual(data); expect(native._mcp.sql).toMatchObject({query_succeeded: false, truncated: true});
  } finally { f.close(); }
});

it("recovers full problem details beyond the previous 32KiB cap", async () => {
  const f = fixture(); const problem = { status: 404, code: "NOT_FOUND", detail: "α".repeat(30000), extension: { evidence: ["001", null] } };
  vi.stubGlobal("fetch", async () => Response.json(problem, { status: 404 }));
  try {
    const result = await invoke(f, "dolthub_execute", { code: 'return await api.get("/api/v2/databases/dolthub/missing");' }, true);
    const native = result.data.data.__staged ? await recover(f, result.data.data.data_access_id, "") : result.data.data;
    expect(native.problem).toEqual(problem); expect(JSON.parse(native.response)).toEqual(problem);
  } finally { f.close(); }
});

it("preserves complete discovery envelopes, cursor evidence and composed citations", async () => {
  const f = fixture(); const data = { name: "example", owner: "dolthub", description: "α😀".repeat(7000), parent: { owner: "source", name: "example" } };
  vi.stubGlobal("fetch", async () => Response.json({ data, meta: { native_extension: "kept" } }));
  try {
    const result = await invoke(f, "mcp_dolthub_discover", { action: "detail", database: "dolthub/example" });
    expect(result.sc.staged).toBe(true); expect(result.data.provider.data).toEqual(data);
    expect(result.data.provider.meta).toEqual({ native_extension: "kept" });
  } finally { f.close(); }
});
