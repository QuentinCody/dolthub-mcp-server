import {McpServer} from "@bio-mcp/shared/mcp";
import {createApiProxyTool} from "@bio-mcp/shared/tools/api-proxy";
import {afterEach, expect, it, vi} from "vitest";
import {createDoltHubApiFetch} from "../lib/api-adapter";
import {dolthubCatalog} from "../spec/catalog";
import {registerCodeMode} from "./code-mode";
import {registerDiscover} from "./discover";
import {registerGetSchema} from "./get-schema";
import {registerQueryData} from "./query-data";

const json = (data: unknown) => new Response(JSON.stringify(data));
afterEach(() => vi.unstubAllGlobals());
function setup(env = {}) {
  const server = new McpServer({name: "fixture", version: "1"});
  registerCodeMode(server, {CODE_MODE_LOADER: {get: () => ({})}} as unknown as Parameters<typeof registerCodeMode>[1]);
  registerQueryData(server, {}); registerGetSchema(server, {}); registerDiscover(server, env);
  return (server as unknown as {_registeredTools: Record<string, {handler: (args: unknown, extra: unknown) => Promise<unknown>}>})._registeredTools;
}
it("registers both aliases and preserves both response fields on success/error", async () => {
  const tools = setup();
  for (const suffix of ["search", "execute", "discover", "query_data", "get_schema"]) { expect(tools[`dolthub_${suffix}`]).toBeDefined(); expect(tools[`mcp_dolthub_${suffix}`]).toBeDefined(); }
  expect(await tools.dolthub_search.handler({query: "revision", category: "workflows", max_results: 5}, {})).toMatchObject({content: expect.any(Array), structuredContent: {success: true}});
  expect(await tools.mcp_dolthub_discover.handler({action: "detail", database: "invalid"}, {})).toMatchObject({isError: true, content: expect.any(Array), structuredContent: {success: false}});
});
it("legacy detail discovery uses v2 and preserves the provider envelope", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({data: {owner: "dolthub", name: "fixture", last_write_at: "2026-09-01T00:00:00Z"}})));
  expect(await setup().dolthub_discover.handler({action: "detail", database: "dolthub/fixture"}, {})).toMatchObject({structuredContent: {data: {owner: "dolthub", name: "fixture", provider: {data: {last_write_at: "2026-09-01T00:00:00Z"}, _mcp: {provenance: {api_version: "v2"}}}}}});
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe("https://www.dolthub.com/api/v2/databases/dolthub/fixture");
});
function storage(stored: unknown[]) {
  return {idFromName: (name: string) => name, get: () => ({fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") {
      stored.push((await request.json() as {data: unknown}).data);
      return json({success: true, tables_created: ["result"], total_rows: 1, input_rows: 1, table_row_counts: {result: 1}});
    }
    return json({success: true, schema: {tables: {result: {columns: [{name: "value"}]}}}});
  }})} as unknown as DurableObjectNamespace;
}
it("stages complete v2 list envelopes including continuation and revision provenance", async () => {
  const raw = {data: [{tag: "fixture", commit_sha: "a".repeat(32), description: "α".repeat(20000)}], meta: {next_page_token: "next"}};
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json(raw)));
  const stored: unknown[] = [];
  const proxy = createApiProxyTool({apiFetch: createDoltHubApiFetch(), catalog: dolthubCatalog, doNamespace: storage(stored), stagingPrefix: "dolthub", maxInlineBytes: 30 * 1024});
  expect(await proxy.handler({method: "GET", path: "/api/v2/databases/dolthub/fixture/releases"}, {sql: () => []})).toMatchObject({__staged: true, data_access_id: expect.any(String)});
  expect(JSON.parse(stored[0] as string)).toMatchObject({...raw, _mcp: {next_request: {params: {page_token: "next"}}}});
});
it("stages hand-built discovery and gives an error when storage is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json({data: {owner: "dolthub", name: "fixture", description: "α".repeat(20000)}})));
  const input = {action: "detail", database: "dolthub/fixture"};
  expect(await setup().dolthub_discover.handler(input, {})).toMatchObject({isError: true, content: expect.any(Array), structuredContent: {success: false}});
  const stored: unknown[] = [];
  const result = await setup({DOLTHUB_DATA_DO: storage(stored)}).dolthub_discover.handler(input, {});
  expect(result).toMatchObject({content: expect.any(Array), structuredContent: {_staging: {data_access_id: expect.any(String)}}});
  expect(stored).toContainEqual(expect.objectContaining({structuredContent: expect.objectContaining({data: expect.objectContaining({owner: "dolthub", name: "fixture", provider: expect.any(Object)})})})); expect(JSON.stringify(result).length).toBeLessThan(100000);
});
