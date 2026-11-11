import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { fail, readDoltResponse } from "./read-response";

type Request = Parameters<ApiFetchFn>[0];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid DoltHub v2 object", 502);
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/.test(value) && name !== "q") fail(`Invalid ${name}`);
  return value;
}
function sqlParams(value: unknown) {
  const input = object(value);
  for (const key of Object.keys(input)) if (!["ref", "q", "limit", "timeout_ms"].includes(key)) fail(`Unsupported SQL parameter: ${key}`);
  const ref = boundedString(input.ref, "ref", 1000);
  const q = boundedString(input.q, "q", 100000);
  const limit = input.limit ?? 1000;
  const timeout = input.timeout_ms ?? 30000;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail("Use limit 1–1000; narrow larger queries");
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 60000) fail("timeout_ms must be 1–60000");
  return {ref, q, limit, timeout_ms: timeout};
}
export async function dolthubV2Read(request: Request, token?: string): Promise<{status: number; data: Record<string, unknown>}> {
  const { url, headers, query, params, isSql, resource } = prepareDoltRequest(request, token);
  let response: Response;
  try { response = await fetch(url, {method: request.method, headers, body: request.method === "POST" ? JSON.stringify(query) : undefined, redirect: "manual", signal: AbortSignal.timeout(70000)}); }
  catch { fail("DoltHub v2 request failed or timed out", 502); }
  const raw = await readDoltResponse(response, token);
  let envelope: Record<string, unknown>;
  try { envelope = object(JSON.parse(raw)); }
  catch { fail(response.ok ? "DoltHub returned invalid JSON envelope" : `DoltHub v2 HTTP ${response.status}`, response.ok ? 502 : response.status,
    { problem: {}, response: raw, http_status: response.status }); }
  if (!response.ok) fail(`DoltHub v2 HTTP ${response.status}${typeof envelope.code === "string" ? ` (${envelope.code})` : ""}`,
    response.status, { problem: envelope, response: raw, http_status: response.status });
  if (!envelope.data || typeof envelope.data !== "object") fail("Missing DoltHub v2 data envelope", 502);
  const { sql, cursor, digest } = await inspectDoltResult(envelope, params, isSql, query, resource, raw);
  return {status: response.status, data: {...envelope, _mcp: {sql,
    next_request: cursor ? {method: "GET", path: request.path, params: {...params, page_token: cursor}} : null,
    atomic_snapshot_verified: false,
    provenance: {source_url: url.toString(), method: request.method, request: query, retrieved_at: new Date().toISOString(), response_sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join(""), response_hash_scope: "decoded UTF-8 response after credential redaction", api_version: "v2"}}}};
}

async function inspectDoltResult(envelope: Record<string, unknown>, params: Record<string, unknown>, isSql: boolean, query: Record<string, unknown>, resource: string, raw: string) {
  const meta = envelope.meta === undefined ? {} : object(envelope.meta);
  const cursor = meta.next_page_token;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 8000 || /[\r\n\0]/.test(cursor))) fail("Invalid DoltHub cursor", 502);
  if (cursor && cursor === params.page_token) fail("DoltHub cursor did not advance", 502);
  let sql: Record<string, unknown> | undefined;
  if (isSql) {
    const result = object(envelope.data);
    if (!["success", "error", "timeout", "row_limit", "not_workspace"].includes(String(result.status))) fail("Unknown DoltHub SQL status", 502);
    if (result.status === "success") {
      if (!Array.isArray(result.columns) || !Array.isArray(result.rows)) fail("Missing DoltHub SQL rows/columns", 502);
      for (const row of result.rows) {
        if (!Array.isArray(row) || row.length !== result.columns.length || row.some(cell => cell !== null && typeof cell !== "string")) fail("Invalid DoltHub SQL row cells", 502);
      }
    }
    sql = {
      query_succeeded: result.status === "success", truncated: result.status === "row_limit", requested_ref: query.ref,
      requested_commit_sha: /^[0-9a-v]{32}$/.test(String(query.ref)) ? query.ref : null,
      resolved_commit_sha: null, note: "Provider QueryResult does not report the resolved commit. Branch/tag names can move. Native v2 commit-ref requests were rejected on 2026-10-04; use explicit AS OF commit clauses where supported and retain the exact SQL and discovered commit. SQL is not cursor-paginated."
    };
  } else if (resource !== "database" && !Array.isArray(envelope.data)) fail("Expected DoltHub resource list", 502);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return { sql, cursor, digest };
}

function prepareDoltRequest(request: { method: string; path: string; params?: Record<string, unknown>; body?: unknown; }, token: string | undefined) {
  const match = /^\/api\/v2\/databases\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9_-]{1,100})(?:\/(branches|tags|forks|releases|sql))?$/.exec(request.path);
  if (!match) fail("Unsupported DoltHub v2 read route");
  const resource = match[3] ?? "database";
  const isSql = resource === "sql";
  if (request.method !== "GET" && !(isSql && request.method === "POST")) fail("Only GET discovery and GET/POST read-only /sql are exposed");
  if (request.method === "GET" && request.body !== undefined) fail("GET cannot include a body");
  const params = request.params ?? {};
  let query: Record<string, unknown> = params;
  if (isSql) {
    if (request.method === "POST" && Object.keys(params).length) fail("POST SQL parameters belong in its JSON body");
    query = sqlParams(request.method === "POST" ? request.body : params);
  } else {
    const paged = ["branches", "tags", "releases"].includes(resource);
    for (const key of Object.keys(params)) if (!paged || key !== "page_token") fail(`Unsupported ${resource} parameter: ${key}`);
    if (params.page_token !== undefined) boundedString(params.page_token, "page_token", 8000);
  }
  const url = new URL(request.path, "https://www.dolthub.com");
  if (request.method === "GET") for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  if (url.toString().length > 16000) fail("Use body-encoded POST /sql for long queries");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (request.method === "POST") headers["Content-Type"] = "application/json";
  return { url, headers, query, params, isSql, resource };
}
