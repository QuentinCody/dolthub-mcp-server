import { afterEach, expect, it, vi } from "vitest";
import { createDoltHubApiFetch } from "./api-adapter";
import { dolthubListRepos, dolthubTableSchemas } from "./http";
import { readDoltResponse } from "./read-response";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const request = { method: "GET" as const, path: "/api/v2/databases/dolthub/example" };

it.each([200, 206])("rejects partial HTTP %s while retaining the complete received body", async status => {
  const response = new Response('{"data":{}}', { status, headers: { "content-range": "bytes 0-10/50" } });
  await expect(readDoltResponse(response)).rejects.toMatchObject({status: 502, data: {response: '{"data":{}}', http_status: status}});
});

it("bounds a stalled body and does not await a stalled cancellation", async () => {
  vi.useFakeTimers();
  const response = new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) }));
  const check = expect(readDoltResponse(response)).rejects.toMatchObject({status: 504});
  await vi.advanceTimersByTimeAsync(15001); await check;
});

it("preserves malformed/non-JSON evidence and redacts the configured credential", async () => {
  vi.stubGlobal("fetch", async () => new Response("<html>fixture-token upstream failure</html>", {status: 503}));
  await expect(createDoltHubApiFetch("fixture-token")(request)).rejects.toMatchObject({status: 503, data: {response: "<html>[REDACTED] upstream failure</html>", http_status: 503}});
  vi.stubGlobal("fetch", async () => new Response('{"data":'));
  await expect(createDoltHubApiFetch()(request)).rejects.toMatchObject({status: 502, data: {response: '{"data":'}});
  await expect(readDoltResponse(new Response(new Uint8Array([0xc3, 0x28])))).rejects.toThrow();
});

it("keeps GraphQL discovery failures distinct from an empty repository list", async () => {
  vi.stubGlobal("fetch", async () => Response.json({errors: [{message: "unknown field"}]}));
  await expect(dolthubListRepos("dolthub")).rejects.toMatchObject({status: 200, data: {errors: [{message: "unknown field"}]}});
});

it("retains an explicitly requested revision in legacy schema fallback", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL) => {
    urls.push(String(url));
    if (String(url).endsWith("/graphql")) return Response.json({errors: [{message: "fixture schema unavailable"}]});
    const sql = new URL(url).searchParams.get("q");
    return Response.json({query_execution_status: "Success", schema: [], rows: sql === "SHOW TABLES" ? [{table: "odd`table"}] : [{Field: "id", Type: "char(3)", Key: "PRI", Null: "NO"}]});
  });
  expect(await dolthubTableSchemas("owner", "database", "feature/slash")).toEqual([{table: "odd`table", columns: [{name: "id", type: "char(3)", primaryKey: true, notNull: true}]}]);
  expect(urls.slice(1).every(url => new URL(url).pathname.endsWith("/feature%2Fslash"))).toBe(true);
  expect(new URL(urls[2]).searchParams.get("q")).toBe("DESCRIBE `odd``table`");
});

it("records a failed DESCRIBE in legacy schema fallback instead of an empty column list", async () => {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    if (String(url).endsWith("/graphql")) return Response.json({errors: [{message: "fixture schema unavailable"}]});
    const sql = new URL(url).searchParams.get("q");
    if (sql === "SHOW TABLES") return Response.json({query_execution_status: "Success", schema: [], rows: [{t: "ok"}, {t: "slow"}]});
    if (sql === "DESCRIBE `slow`") return new Response("bad gateway", {status: 502});
    return Response.json({query_execution_status: "Success", schema: [], rows: [{Field: "id", Type: "int", Key: "PRI", Null: "NO"}]});
  });
  const schemas = await dolthubTableSchemas("owner", "database");
  expect(schemas[0]).toEqual({table: "ok", columns: [{name: "id", type: "int", primaryKey: true, notNull: true}]});
  expect(schemas[1]).toMatchObject({table: "slow", columns: [], error: {status: 502}});
});
