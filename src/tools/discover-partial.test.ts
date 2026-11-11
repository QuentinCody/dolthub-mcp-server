import { afterEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));

import { fixture } from "./staging-fixture";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** GraphQL schema read fails (forces the SQL fallback); DESCRIBE and COUNT fail for table `slow` only. */
function stubDoltHub() {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    if (String(url).endsWith("/graphql")) return Response.json({errors: [{message: "fixture schema unavailable"}]});
    const sql = new URL(url).searchParams.get("q") ?? "";
    if (sql === "SHOW TABLES") return Response.json({query_execution_status: "Success", schema: [], rows: [{t: "ok"}, {t: "slow"}]});
    if (sql.includes("`slow`")) return new Response("bad gateway", {status: 502});
    if (sql.startsWith("DESCRIBE")) return Response.json({query_execution_status: "Success", schema: [], rows: [{Field: "id", Type: "int", Key: "PRI", Null: "NO"}]});
    return Response.json({query_execution_status: "Success", schema: [], rows: [{cnt: "7"}]});
  });
}

it("tables: a failed DESCRIBE marks the result as an error, not an empty schema", async () => {
  const f = fixture(); stubDoltHub();
  try {
    const result = await f.tools.dolthub_discover.handler({ action: "tables", database: "owner/db" }, {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, disposition: "partial" });
    expect(result.structuredContent.data.failed_tables).toEqual(["slow"]);
    expect(result.structuredContent.data.tables[1]).toMatchObject({ table: "slow", columns: [], error: { status: 502 } });
  } finally { f.close(); }
});

it("stats: failed COUNT(*) and DESCRIBE give null counts with errors, not rows: -1 in a success", async () => {
  const f = fixture(); stubDoltHub();
  try {
    const result = await f.tools.dolthub_discover.handler({ action: "stats", database: "owner/db" }, {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, disposition: "partial" });
    const [ok, slow] = result.structuredContent.data.tables;
    expect(ok).toEqual({ table: "ok", rows: 7, columns: 1 });
    expect(slow).toMatchObject({ table: "slow", rows: null, columns: null, error: { rows: { status: 502 }, columns: { status: 502 } } });
  } finally { f.close(); }
});

it("stats: a fully readable database stays a success", async () => {
  const f = fixture();
  vi.stubGlobal("fetch", async (url: string | URL) => {
    if (String(url).endsWith("/graphql")) return Response.json({data: {tables: [{tableName: "ok", columns: [{name: "id", type: "int", isPrimaryKey: true, constraints: []}]}]}});
    return Response.json({query_execution_status: "Success", schema: [], rows: [{cnt: "3"}]});
  });
  try {
    const result = await f.tools.dolthub_discover.handler({ action: "stats", database: "owner/db" }, {});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.data).toEqual({ database: "owner/db", tables: [{ table: "ok", rows: 3, columns: 1 }] });
  } finally { f.close(); }
});
