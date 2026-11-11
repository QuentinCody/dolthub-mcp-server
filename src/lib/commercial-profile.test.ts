import { LICENSE_PROFILE_META_KEY } from "@bio-mcp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));

import { fixture } from "../tools/staging-fixture";
import { createDoltHubApiFetch } from "./api-adapter";
import {
  LICENSE_CACHE_TTL_MS, LICENSE_SQL, clearLicenseCache, databaseOfPath, identifyLicense, licenseSource, readDatabaseLicense,
} from "./commercial-profile";
import { CC0_LEGAL_CODE, CC_BY_NC_OPENING, MIT_TEXT } from "./license-fixtures";

// License audit 2026-11-10: "Allow only the databases whose license permits
// commercial use." DoltHub has no license field in its API; the license of a
// database is its LICENSE.md in the `dolt_docs` table. A reselling caller gets a
// database only when that text is a known form of a license that permits
// commercial use. Each other case is refused with HTTP 451 before any data request.

const commercial = { licenseProfile: "commercial" as const };
const commercialExtra = { _meta: { [LICENSE_PROFILE_META_KEY]: "commercial" } };

type Reply = () => Response | Promise<Response>;
const DOC_SCHEMA = [{ columnName: "doc_name", columnType: "varchar(1023)" }, { columnName: "doc_text", columnType: "longtext" }];
/** The reply of DoltHub to `LICENSE_SQL` (shape of a read of dolthub/us-jails, 2026-11-10). */
const docs = (database: string, rows: unknown[], commit_ref = "main"): Reply => () => {
  const [repository_owner, repository_name] = database.split("/");
  return Response.json({ query_execution_status: "Success", query_execution_message: "", repository_owner, repository_name,
    commit_ref, sql_query: LICENSE_SQL, schema: DOC_SCHEMA, rows });
};
const license = (database: string, doc_text: string) => docs(database, [{ doc_name: "LICENSE.md", doc_text }]);
const sqlError = (database: string, message: string): Reply => () => {
  const [repository_owner, repository_name] = database.split("/");
  return Response.json({ query_execution_status: "Error", query_execution_message: message, repository_owner, repository_name,
    commit_ref: "main", sql_query: LICENSE_SQL, schema: [], rows: [] });
};

/** DoltHub. `licenses` gives the reply to the license read of each owner/database; each other request is a data request. */
function upstream(licenses: Record<string, Reply>) {
  const licenseReads: string[] = [];
  const dataRequests: string[] = [];
  const graphqlBodies: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const sql = url.searchParams.get("q");
    if (url.pathname.startsWith("/api/v1alpha1/") && sql === LICENSE_SQL) {
      const database = url.pathname.slice("/api/v1alpha1/".length);
      licenseReads.push(database);
      return (licenses[database] ?? (() => new Response("not found", { status: 404 })))();
    }
    dataRequests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/graphql") graphqlBodies.push(String(init?.body));
    if (url.pathname === "/graphql") return Response.json({ data: { tables: [{ tableName: "t", columns: [{ name: "id", type: "int", isPrimaryKey: true, constraints: [] }] }] } });
    if (url.pathname.endsWith("/sql")) return Response.json({ data: { status: "success", columns: [{ name: "id", type: "INT" }], rows: [["1"]] } });
    if (/\/(branches|tags|releases|forks)$/.test(url.pathname)) return Response.json({ data: [{ name: "main", head_commit_sha: "k1v9e3s0b5q6m2lq8dfr7ftaht3a8sb2" }] });
    if (url.pathname.startsWith("/api/v2/")) return Response.json({ data: { owner: "o", name: "d", visibility: "public", star_count: 1 } });
    const [repository_owner, repository_name] = url.pathname.slice("/api/v1alpha1/".length).split("/");
    return Response.json({ query_execution_status: "Success", query_execution_message: "", repository_owner, repository_name,
      commit_ref: "main", sql_query: sql, schema: [{ columnName: "id", columnType: "int" }], rows: [{ id: "1" }] });
  });
  return { licenseReads, dataRequests, graphqlBodies };
}

afterEach(() => { clearLicenseCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("identifyLicense: exact known forms only", () => {
  it.each([
    ["the CC0 legal code that DoltHub gives", CC0_LEGAL_CODE, "CC0-1.0"],
    ["the CC0 legal code with other line breaks and a byte order mark", `﻿${CC0_LEGAL_CODE.replace(/\n/g, "\r\n  ")}`, "CC0-1.0"],
    ["the MIT text with its copyright line", MIT_TEXT, "MIT"],
    ["an SPDX identifier only", " CC-BY-4.0\n", "CC-BY-4.0"],
    ["an SPDX identifier line in another case", "SPDX-License-Identifier: odbl-1.0", "ODbL-1.0"],
  ])("accepts %s", async (_name, text, id) => {
    expect(await identifyLicense(text)).toBe(id);
  });

  it.each([
    ["the CC0 legal code with an added restriction", `${CC0_LEGAL_CODE}\nCommercial use of this database is not permitted.\n`],
    ["the CC BY-NC 4.0 legal code", CC_BY_NC_OPENING],
    ["a non-commercial SPDX identifier", "CC-BY-NC-4.0"],
    ["a name of a license, not its identifier", "This data is licensed under CC0."],
    ["the MIT text with a restriction before it", MIT_TEXT.replace("Copyright (c) 2024 Example Data Owner", "Copyright (c) 2024 Example\nNot for commercial use.")],
    ["the MIT text with a changed word", MIT_TEXT.replace("without restriction", "with restriction")],
    ["the template that `dolt init` writes", "This is a repository level LICENSE. Either edit it, add it to .doltignore or remove it."],
    ["an empty text", "  \n "],
  ])("refuses %s", async (_name, text) => {
    expect(await identifyLicense(text)).toBeUndefined();
  });
});

describe("DoltHub adapter under the commercial license profile", () => {
  it("serves a CC0 database through the legacy route, with the license that permits it", async () => {
    const { licenseReads, dataRequests } = upstream({ "dolthub/us-jails": license("dolthub/us-jails", CC0_LEGAL_CODE) });
    const result = await createDoltHubApiFetch()({ method: "GET", path: "/dolthub/us-jails", params: { q: "SELECT id FROM jails" }, ...commercial });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      rows: [{ id: "1" }],
      database_license: { id: "CC0-1.0", status: "permitted", doc: "LICENSE.md", ref: "main", source: licenseSource("dolthub", "us-jails") },
    });
    expect(licenseReads).toEqual(["dolthub/us-jails"]);
    expect(dataRequests).toEqual(["GET /api/v1alpha1/dolthub/us-jails"]);
  });

  it("serves the v2 SQL and metadata routes of an open database and reads the license once", async () => {
    const { licenseReads, dataRequests } = upstream({ "o/d": license("o/d", "CC-BY-4.0") });
    const api = createDoltHubApiFetch();
    const sql = await api({ method: "POST", path: "/api/v2/databases/o/d/sql", body: { ref: "main", q: "SELECT id FROM t" }, ...commercial });
    const meta = await api({ method: "GET", path: "/api/v2/databases/o/d", ...commercial });
    for (const result of [sql, meta]) {
      expect(result.status).toBe(200);
      expect(result.data).toMatchObject({ database_license: { id: "CC-BY-4.0", conditions: "attribution" } });
    }
    expect(licenseReads).toEqual(["o/d"]);
    expect(dataRequests).toEqual(["POST /api/v2/databases/o/d/sql", "GET /api/v2/databases/o/d"]);
  });

  const refused: Array<[string, Reply, RegExp]> = [
    ["a non-commercial license", license("o/d", CC_BY_NC_OPENING), /not a known form/],
    ["a known license text with an added restriction", license("o/d", `${CC0_LEGAL_CODE}\nNo commercial use.`), /not a known form/],
    ["no LICENSE.md", docs("o/d", []), /has no license/],
    ["an empty LICENSE.md", license("o/d", "\n"), /has no license/],
    ["no dolt_docs table", sqlError("o/d", "table not found: dolt_docs"), /has no license/],
    ["HTTP 500", () => new Response("upstream error", { status: 500 }), /could not be read/],
    ["HTTP 404 (no such database)", () => new Response("not found", { status: 404 }), /could not be read/],
    ["a network error", () => { throw new TypeError("fetch failed"); }, /could not be read/],
    ["a reply that is not JSON", () => new Response("<html>"), /could not be read/],
    ["a reply for a different database", license("other/d", CC0_LEGAL_CODE), /could not be read/],
    ["a doc_text that is not text", docs("o/d", [{ doc_name: "LICENSE.md", doc_text: null }]), /could not be read/],
  ];

  it.each(refused)("refuses a database with %s: HTTP 451 and no data request", async (_name, reply, reason) => {
    const { licenseReads, dataRequests } = upstream({ "o/d": reply });
    const api = createDoltHubApiFetch();
    const requests = [
      { method: "GET", path: "/o/d", params: { q: "SELECT id FROM t" } },
      { method: "GET", path: "/api/v2/databases/o/d/sql", params: { ref: "main", q: "SELECT id FROM t" } },
      { method: "GET", path: "/api/v2/databases/o/d/branches" },
    ];
    for (const request of requests) {
      const result = await api({ ...request, ...commercial });
      expect(result.status).toBe(451);
      expect(result.data).toMatchObject({ error: "NOT_LICENSED_FOR_COMMERCIAL_USE" });
      const message = String((result.data as { message: string }).message);
      expect(message).toContain("o/d");
      expect(message).toMatch(reason);
    }
    expect(dataRequests).toEqual([]);
    expect(licenseReads.length).toBeGreaterThan(0);
  });

  it("refuses a path that names no database without any request", async () => {
    const { licenseReads, dataRequests } = upstream({});
    const result = await createDoltHubApiFetch()({ method: "GET", path: "/api/v2/users/o", ...commercial });
    expect(result.status).toBe(451);
    expect(licenseReads).toEqual([]);
    expect(dataRequests).toEqual([]);
    expect(databaseOfPath("/o/d")).toEqual({ owner: "o", database: "d" });
    expect(databaseOfPath("/api/v2/databases/o/d/tags")).toEqual({ owner: "o", database: "d" });
    expect(databaseOfPath("/o/d/main")).toBeUndefined();
  });

  it("does not change a caller without the profile, also for a database without a license", async () => {
    const { licenseReads, dataRequests } = upstream({ "o/d": docs("o/d", []) });
    const api = createDoltHubApiFetch();
    const legacy = await api({ method: "GET", path: "/o/d", params: { q: "SELECT id FROM t" } });
    const v2 = await api({ method: "GET", path: "/api/v2/databases/o/d" });
    expect(legacy.status).toBe(200);
    expect(v2.status).toBe(200);
    expect(legacy.data).not.toHaveProperty("database_license");
    expect(v2.data).not.toHaveProperty("database_license");
    expect(licenseReads).toEqual([]);
    expect(dataRequests).toEqual(["GET /api/v1alpha1/o/d", "GET /api/v2/databases/o/d"]);
  });

  it("keeps a read license for a short time, and reads again after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { licenseReads } = upstream({ "o/d": license("o/d", CC0_LEGAL_CODE) });
    const api = createDoltHubApiFetch();
    const request = { method: "GET", path: "/o/d", params: { q: "SELECT id FROM t" }, ...commercial };
    await api(request);
    await api(request);
    expect(licenseReads).toEqual(["o/d"]);
    vi.setSystemTime(Date.now() + LICENSE_CACHE_TTL_MS + 1);
    await api(request);
    expect(licenseReads).toEqual(["o/d", "o/d"]);
  });

  it("does not keep a license read that failed", async () => {
    let fail = true;
    const { licenseReads, dataRequests } = upstream({ "o/d": () => (fail ? new Response("busy", { status: 503 }) : license("o/d", CC0_LEGAL_CODE)()) });
    const api = createDoltHubApiFetch();
    const request = { method: "GET", path: "/o/d", params: { q: "SELECT id FROM t" }, ...commercial };
    expect((await api(request)).status).toBe(451);
    fail = false;
    expect((await api(request)).status).toBe(200);
    expect(licenseReads).toEqual(["o/d", "o/d"]);
    expect(dataRequests).toEqual(["GET /api/v1alpha1/o/d"]);
  });

  it("reads the license on the default branch with one SQL query", async () => {
    upstream({ "o/d": docs("o/d", [{ doc_name: "LICENSE.md", doc_text: MIT_TEXT }], "master") });
    expect(await readDatabaseLicense("o", "d")).toMatchObject({ status: "permitted", id: "MIT", ref: "master", database: "o/d" });
    expect(LICENSE_SQL).toBe("SELECT doc_name, doc_text FROM dolt_docs WHERE doc_name = 'LICENSE.md'");
  });
});

// Coordinator decision 2026-11-10 (fail closed): only the default branch whose
// LICENSE.md was read is served. Another ref, AS OF, dolt_diff, dolt_history_,
// dolt_commit_diff_ and a `@` revision qualifier are refused with 451.
describe("only the default branch whose license was read", () => {
  const sqlForms: Array<[string, string]> = [
    ["AS OF a commit", "SELECT * FROM t AS OF 'k1v9e3s0b5q6m2lq8dfr7ftaht3a8sb2'"],
    ["as of in lower case over a line break", "select * from t as\n  of HASHOF('main~1')"],
    ["AS OF split by a comment", "SELECT * FROM t AS/**/OF 'main~1'"],
    ["the dolt_diff table function", "SELECT * FROM DOLT_DIFF('main~1', 'main', 't')"],
    ["a dolt_diff_<table> system table", "SELECT * FROM dolt_diff_t"],
    ["a dolt_history_<table> system table", "SELECT * FROM dolt_history_t"],
    ["a dolt_commit_diff_<table> system table", "SELECT * FROM dolt_commit_diff_t WHERE to_commit = 'main'"],
    ["a @ revision qualifier on a table", "SELECT * FROM `t@feature`"],
    ["a @ revision qualifier on a database", "SELECT * FROM `d@k1v9e3s0`.t"],
    ["a database/branch qualifier", "SELECT * FROM `d/feature`.t"],
  ];

  it.each(sqlForms)("refuses SQL with %s on the legacy and v2 routes, with no data request", async (_name, q) => {
    const { dataRequests } = upstream({ "o/d": license("o/d", CC0_LEGAL_CODE) });
    const api = createDoltHubApiFetch();
    for (const request of [
      { method: "GET", path: "/o/d", params: { q } },
      { method: "GET", path: "/api/v2/databases/o/d/sql", params: { ref: "main", q } },
      { method: "POST", path: "/api/v2/databases/o/d/sql", body: { ref: "main", q } },
    ]) {
      const result = await api({ ...request, ...commercial });
      expect(result.status).toBe(451);
      expect(result.data).toMatchObject({ error: "NOT_LICENSED_FOR_COMMERCIAL_USE" });
      expect(String((result.data as { message: string }).message)).toContain("Only the default branch (main), whose LICENSE.md was checked, is served");
    }
    expect(dataRequests).toEqual([]);
  });

  const refForms: Array<[string, { method: string; path: string; params?: Record<string, unknown>; body?: unknown }]> = [
    ["a legacy ref parameter for another branch", { method: "GET", path: "/o/d", params: { q: "SELECT id FROM t", ref: "feature" } }],
    ["a legacy ref parameter for a tag", { method: "GET", path: "/o/d", params: { q: "SELECT id FROM t", ref: "v1.0" } }],
    ["a v2 GET ref for a commit", { method: "GET", path: "/api/v2/databases/o/d/sql", params: { ref: "k1v9e3s0b5q6m2lq8dfr7ftaht3a8sb2", q: "SELECT id FROM t" } }],
    ["a v2 POST body ref for another branch", { method: "POST", path: "/api/v2/databases/o/d/sql", body: { ref: "dev", q: "SELECT id FROM t" } }],
    ["a ref that differs only in case", { method: "GET", path: "/o/d", params: { q: "SELECT id FROM t", ref: "Main" } }],
  ];

  it.each(refForms)("refuses %s, with no data request", async (_name, request) => {
    const { dataRequests } = upstream({ "o/d": license("o/d", CC0_LEGAL_CODE) });
    const result = await createDoltHubApiFetch()({ ...request, ...commercial });
    expect(result.status).toBe(451);
    expect(String((result.data as { message: string }).message)).toMatch(/it reads the ref .*Only the default branch \(main\)/);
    expect(dataRequests).toEqual([]);
  });

  it("refuses the ref main when the default branch is master", async () => {
    const { dataRequests } = upstream({ "o/d": docs("o/d", [{ doc_name: "LICENSE.md", doc_text: CC0_LEGAL_CODE }], "master") });
    const result = await createDoltHubApiFetch()({ method: "POST", path: "/api/v2/databases/o/d/sql", body: { ref: "main", q: "SELECT id FROM t" }, ...commercial });
    expect(result.status).toBe(451);
    expect(dataRequests).toEqual([]);
  });

  it("still serves the default branch: no ref, the same ref, and plain SQL", async () => {
    const { dataRequests } = upstream({ "o/d": license("o/d", CC0_LEGAL_CODE) });
    const api = createDoltHubApiFetch();
    const requests = [
      { method: "GET", path: "/o/d", params: { q: "SELECT id, name AS label FROM t WHERE id > 0" } },
      { method: "GET", path: "/o/d", params: { q: "SELECT id FROM t", ref: "main" } },
      { method: "GET", path: "/api/v2/databases/o/d/sql", params: { ref: "main", q: "SELECT COUNT(*) FROM t" } },
      { method: "POST", path: "/api/v2/databases/o/d/sql", body: { ref: "main", q: "SELECT id FROM t ORDER BY id LIMIT 5" } },
      { method: "GET", path: "/api/v2/databases/o/d/branches" },
    ];
    for (const request of requests) {
      const result = await api({ ...request, ...commercial });
      expect(result.status, JSON.stringify(request)).toBe(200);
      expect(result.data).toMatchObject({ database_license: { id: "CC0-1.0", ref: "main" } });
    }
    expect(dataRequests).toHaveLength(requests.length);
  });

  it("dolthub_discover sample: refuses a table name with a revision qualifier, with no data request", async () => {
    const f = fixture();
    const { dataRequests } = upstream({ "o/d": license("o/d", CC0_LEGAL_CODE) });
    try {
      for (const table of ["t@feature", "dolt_history_t", "dolt_diff_t"]) {
        const result = await f.tools.dolthub_discover.handler({ action: "sample", database: "o/d", table }, commercialExtra);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: "NOT_LICENSED_FOR_COMMERCIAL_USE", status: 451 } });
        expect(result.structuredContent.error.message).toContain("Only the default branch (main)");
      }
      expect(dataRequests).toEqual([]);
    } finally { f.close(); }
  });

  it("dolthub_discover tables, sample and stats read the default branch of the license read", async () => {
    const f = fixture();
    const { dataRequests, graphqlBodies } = upstream({ "o/d": docs("o/d", [{ doc_name: "LICENSE.md", doc_text: CC0_LEGAL_CODE }], "master") });
    try {
      for (const action of ["tables", "sample", "stats"]) {
        const result = await f.tools.dolthub_discover.handler({ action, database: "o/d", table: "t" }, commercialExtra);
        expect(result.isError, JSON.stringify(result).slice(0, 300)).not.toBe(true);
      }
      expect(graphqlBodies.length).toBeGreaterThan(0);
      expect(graphqlBodies.every(body => body.includes('refName: \\"master\\"'))).toBe(true);
      expect(dataRequests.filter(r => r.startsWith("GET /api/v1alpha1/"))).toEqual(["GET /api/v1alpha1/o/d/master", "GET /api/v1alpha1/o/d/master"]);
    } finally { f.close(); }
  });
});

describe("DoltHub tools under the commercial license profile", () => {
  it("dolthub_execute: a closed database is refused in the isolate and gets no data request", async () => {
    const f = fixture();
    const { dataRequests } = upstream({ "o/closed": docs("o/closed", []), "o/open": license("o/open", CC0_LEGAL_CODE) });
    try {
      const closed = await f.tools.dolthub_execute.handler({ code: 'return await api.get("/o/closed", {q: "SELECT id FROM t"});' }, commercialExtra);
      expect(closed.isError).toBe(true);
      expect(JSON.stringify(closed)).toContain("NOT_LICENSED_FOR_COMMERCIAL_USE");
      expect(dataRequests).toEqual([]);
      const open = await f.tools.dolthub_execute.handler({ code: 'return await api.get("/o/open", {q: "SELECT id FROM t"});' }, commercialExtra);
      expect(open.isError, JSON.stringify(open).slice(0, 400)).not.toBe(true);
      expect(open.structuredContent.data).toMatchObject({ database_license: { id: "CC0-1.0" } });
      expect(dataRequests).toEqual(["GET /api/v1alpha1/o/open"]);
    } finally { f.close(); }
  });

  it.each(["detail", "tables", "sample", "stats"])("dolthub_discover %s: refused for a database without a license, before any data request", async action => {
    const f = fixture();
    const { licenseReads, dataRequests } = upstream({ "o/d": docs("o/d", []) });
    try {
      const result = await f.tools.dolthub_discover.handler({ action, database: "o/d", table: "t" }, commercialExtra);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ success: false, error: { code: "NOT_LICENSED_FOR_COMMERCIAL_USE", status: 451 } });
      expect(licenseReads).toEqual(["o/d"]);
      expect(dataRequests).toEqual([]);
    } finally { f.close(); }
  });

  it.each(["detail", "tables", "sample", "stats"])("dolthub_discover %s: an open database carries its license", async action => {
    const f = fixture();
    upstream({ "o/d": license("o/d", CC0_LEGAL_CODE) });
    try {
      const result = await f.tools.dolthub_discover.handler({ action, database: "o/d", table: "t" }, commercialExtra);
      expect(result.isError, JSON.stringify(result).slice(0, 400)).not.toBe(true);
      expect(result.structuredContent.data).toMatchObject({ database_license: { id: "CC0-1.0", status: "permitted" } });
    } finally { f.close(); }
  });

  it("dolthub_discover search: lists databases and marks each license unknown", async () => {
    const f = fixture();
    const { licenseReads } = upstream({});
    try {
      const result = await f.tools.dolthub_discover.handler({ action: "search", query: "hospital" }, commercialExtra);
      const listed = result.structuredContent.data.results as Array<{ database: string; database_license: { status: string } }>;
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.every(item => item.database_license.status === "unknown")).toBe(true);
      expect(licenseReads).toEqual([]);
    } finally { f.close(); }
  });

  it("dolthub_discover without the profile: no license read and no license field", async () => {
    const f = fixture();
    const { licenseReads, dataRequests } = upstream({ "o/d": docs("o/d", []) });
    try {
      const sample = await f.tools.dolthub_discover.handler({ action: "sample", database: "o/d", table: "t" }, {});
      const search = await f.tools.dolthub_discover.handler({ action: "search", query: "hospital" }, {});
      expect(sample.isError).not.toBe(true);
      expect(sample.structuredContent.data).not.toHaveProperty("database_license");
      expect(search.structuredContent.data.results[0]).not.toHaveProperty("database_license");
      expect(licenseReads).toEqual([]);
      expect(dataRequests).toEqual(["GET /api/v1alpha1/o/d"]);
    } finally { f.close(); }
  });
});
