/**
 * The commercial license profile for the DoltHub adapter and tools.
 *
 * License audit 2026-11-10: "Allow only the databases whose license permits
 * commercial use." A reselling caller sends `licenseProfile: "commercial"`.
 * Before the server reads a database for that caller, it reads the license of
 * the database and serves the database only when the license is in
 * `COMMERCIAL_USE_LICENSES`. Each other case is refused with HTTP 451 and no
 * data request: no license, a license that is not a known form, a license
 * that does not permit commercial use, and a license that cannot be read.
 *
 * Where the license is. DoltHub has no license field in its API: the v2
 * database record (`/api/v2/databases/{owner}/{database}`) gives only owner,
 * name, description, visibility, fork_network_count, star_count, size_bytes
 * and last_write_at (read 2026-11-10), and the GraphQL `Repo` type has no
 * `license` field ("Cannot query field \"license\" on type \"Repo\"."). The
 * license is the `LICENSE.md` doc of the database: "`dolt_docs` stores the
 * contents of Dolt docs (`LICENSE.md`, `README.md`)"
 * (https://www.dolthub.com/docs/sql-reference/version-control/dolt-system-tables),
 * and "As far as Dolt is concerned, we support adding a `LICENSE.md` file"
 * that "can contain your own custom license, or an off the shelf license"
 * (https://www.dolthub.com/blog/2020-02-24-data-licenses/). The server reads
 * it with one SQL query on the default branch (`LICENSE_SQL`).
 *
 * No license is not permission. The DoltHub terms give other users of a
 * public repository "a nonexclusive, worldwide license to use, display, and
 * perform Your Content through the DoltHub Service and to reproduce Your
 * Content solely on DoltHub", and "You may grant further rights if you adopt
 * a license" (https://www.dolthub.com/terms, section D). A resold result is
 * outside DoltHub, so only an adopted license can permit it.
 *
 * Scope. The SQL of a request reaches only its own database: `SHOW DATABASES`
 * gives `information_schema` and the database itself, and a table of another
 * database fails with "database not found" (read 2026-11-10). The host is
 * fixed (www.dolthub.com). The caller chooses the owner, the database and the
 * ref; the license is read per owner/database on the default branch.
 */

import { type ApiFetchFn, commercialUseRefusal } from "@bio-mcp/shared/codemode/catalog";
import { dolthubQuery, upstreamErrorSummary } from "./http";

type DoltRequest = Parameters<ApiFetchFn>[0];
type Refusal = ReturnType<typeof commercialUseRefusal>;

const DOLTHUB_API_BASE = "https://www.dolthub.com/api/v1alpha1";

/** The SQL that reads the license of a database. No ref: DoltHub reads the default branch. */
export const LICENSE_SQL = "SELECT doc_name, doc_text FROM dolt_docs WHERE doc_name = 'LICENSE.md'";

export interface CommercialUseLicense {
  /** SPDX identifier. */
  id: string;
  name: string;
  /** What the license asks of a commercial user. The server does not enforce it; it shows it. */
  conditions: string;
}

/** The licenses under which a reselling caller gets a database, by SPDX identifier. */
export const COMMERCIAL_USE_LICENSES: ReadonlyMap<string, CommercialUseLicense> = new Map(
  ([
    ["CC0-1.0", "Creative Commons CC0 1.0 Universal", "none (public domain dedication)"],
    ["PDDL-1.0", "Open Data Commons Public Domain Dedication and License 1.0", "none (public domain dedication)"],
    ["CC-BY-4.0", "Creative Commons Attribution 4.0 International", "attribution"],
    ["CC-BY-SA-4.0", "Creative Commons Attribution-ShareAlike 4.0 International", "attribution; adapted material under the same license"],
    ["ODbL-1.0", "Open Data Commons Open Database License 1.0", "attribution; a derived database that is made public under the same license"],
    ["MIT", "MIT License", "keep the copyright and permission notice"],
    ["Apache-2.0", "Apache License 2.0", "keep the license and notices"],
  ] as const).map(([id, name, conditions]) => [id, { id, name, conditions }]),
);
const LICENSE_IDS = [...COMMERCIAL_USE_LICENSES.keys()].join(", ");

/**
 * SHA-256 of `normalizeLicenseText` of each known full text. Each comes from
 * the official plain text of the license (2026-11-10):
 * creativecommons.org/publicdomain/zero/1.0/legalcode.txt, .../licenses/by/4.0/legalcode.txt,
 * .../licenses/by-sa/4.0/legalcode.txt, opendatacommons.org/licenses/odbl/odbl-10.txt,
 * opendatacommons.org/licenses/pddl/pddl-10.txt and www.apache.org/licenses/LICENSE-2.0.txt.
 * The LICENSE.md of dolthub/us-jails (CC0) and of post-no-preference/options
 * (CC BY-SA 4.0) give the same hashes. A changed word gives a different hash,
 * so a full text with an added restriction is not a match.
 */
const KNOWN_TEXT_SHA256: ReadonlyMap<string, string> = new Map([
  ["05d9f1a0af61535887a399e161c9d14d1f898043b61d05fe4854ed8c6460179c", "CC0-1.0"],
  ["1f5a529dc95849305307f0d6861169d8cae9e99807e4abcec68ef9ad19235652", "CC-BY-4.0"],
  ["b201beff45fc266662d8e5fba407882facbb5cdfafcd4c8aaa45108a939c01a7", "CC-BY-SA-4.0"],
  ["35c51e2ce4c4aaccb3904ec000dc2565e6dba41a84c6c8f8f8171beb78729182", "ODbL-1.0"],
  ["f3f061136a09aa230c9aa5e510c7024ab1e03b5d7e7f888aeb3daa40850b690c", "PDDL-1.0"],
  ["0ffddef9e48f8a09aed5caf2d44f7ba1c1be2d9b8e0a6f693b1635b2d5566645", "Apache-2.0"],
]);

/**
 * SHA-256 of the normalized MIT text from "Permission is hereby granted" to
 * its end (spdx/license-list-data text/MIT.txt). Before that line, an MIT
 * LICENSE.md may have only a title line and copyright lines (`MIT_PREFIX_LINE`).
 */
const MIT_BODY_SHA256 = "fe2a9817987f862eaced948f0468c7f51d2fedfc48c5c505b246a49a3870e9a5";
const MIT_BODY_START = "Permission is hereby granted";
const MIT_PREFIX_LINE = /^(?:(?:The )?MIT License(?: \(MIT\))?|Copyright (?:\(c\) |\(C\) |© )?[^\n]{1,200})$/;

/** One space for each run of white space, no byte order mark, no space at the two ends. */
export function normalizeLicenseText(text: string): string {
  return text.replace(/^﻿/, "").replace(/\s+/g, " ").trim();
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

async function mitLicense(text: string): Promise<boolean> {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const start = lines.findIndex(line => line.trim().startsWith(MIT_BODY_START));
  if (start < 0) return false;
  const prefix = lines.slice(0, start).map(line => line.trim()).filter(Boolean);
  if (prefix.length > 6 || !prefix.every(line => MIT_PREFIX_LINE.test(line))) return false;
  return (await sha256Hex(normalizeLicenseText(lines.slice(start).join("\n")))) === MIT_BODY_SHA256;
}

/**
 * The SPDX identifier of the license that `text` states, when `text` is a
 * known form: only an identifier of `COMMERCIAL_USE_LICENSES` (also as
 * "SPDX-License-Identifier: <id>"), a known full text, or the MIT text with
 * its copyright lines. Undefined for each other text.
 */
export async function identifyLicense(text: string): Promise<string | undefined> {
  const normalized = normalizeLicenseText(text);
  if (!normalized) return undefined;
  const spdx = /^(?:SPDX-License-Identifier: ?)?([A-Za-z0-9.+-]{1,40})$/.exec(normalized)?.[1]?.toLowerCase();
  if (spdx) return [...COMMERCIAL_USE_LICENSES.keys()].find(id => id.toLowerCase() === spdx);
  const known = KNOWN_TEXT_SHA256.get(await sha256Hex(normalized));
  if (known) return known;
  return (await mitLicense(text)) ? "MIT" : undefined;
}

export type LicenseStatus = "permitted" | "not_permitted" | "absent" | "unreadable";

export interface DatabaseLicense {
  database: string;
  status: LicenseStatus;
  /** SPDX identifier of a permitted license; null for each other status. */
  id: string | null;
  /** The request that read the license. */
  source: string;
  doc: "LICENSE.md";
  /** The branch that DoltHub read (its default branch), when the read succeeded. */
  ref: string | null;
  /** SHA-256 of the normalized LICENSE.md text, when there is one. */
  text_sha256: string | null;
  read_at: string;
  detail?: string;
}

/** The license as a served result shows it (`database_license`). */
export interface ServedLicense extends DatabaseLicense {
  status: "permitted";
  id: string;
  name: string;
  conditions: string;
}

export const licenseSource = (owner: string, database: string) =>
  `${DOLTHUB_API_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(database)}?q=${encodeURIComponent(LICENSE_SQL)}`;

/** Read the license of a database from its `dolt_docs` table. Each failure gives `status: "unreadable"`. */
export async function readDatabaseLicense(owner: string, database: string): Promise<DatabaseLicense> {
  const base = { database: `${owner}/${database}`, id: null, source: licenseSource(owner, database), doc: "LICENSE.md" as const,
    ref: null, text_sha256: null, read_at: new Date().toISOString() };
  let result: Awaited<ReturnType<typeof dolthubQuery>>;
  try {
    result = await dolthubQuery(owner, database, LICENSE_SQL);
  } catch (error) {
    const { message } = upstreamErrorSummary(error);
    const native = error && typeof error === "object" && "data" in error ? JSON.stringify(error.data ?? "") : "";
    // A database without the docs table has no license.
    if (/table not found: dolt_docs/i.test(native)) return { ...base, status: "absent", detail: "the database has no dolt_docs table" };
    return { ...base, status: "unreadable", detail: message };
  }
  const echoed = `${result.repository_owner}/${result.repository_name}`.toLowerCase() === base.database.toLowerCase();
  if (!echoed || result.query_execution_status !== "Success") {
    return { ...base, status: "unreadable", detail: echoed ? `query status ${result.query_execution_status}` : "the reply names a different database" };
  }
  const ref = typeof result.commit_ref === "string" ? result.commit_ref : null;
  if (result.rows.length === 0) return { ...base, ref, status: "absent", detail: "no LICENSE.md in dolt_docs" };
  const text = result.rows[0].doc_text;
  if (result.rows.length !== 1 || result.rows[0].doc_name !== "LICENSE.md" || typeof text !== "string") {
    return { ...base, ref, status: "unreadable", detail: "the dolt_docs reply is not one LICENSE.md text" };
  }
  const normalized = normalizeLicenseText(text);
  if (!normalized) return { ...base, ref, status: "absent", detail: "LICENSE.md is empty" };
  const sha = await sha256Hex(normalized);
  const id = await identifyLicense(text);
  return id ? { ...base, ref, text_sha256: sha, status: "permitted", id }
    : { ...base, ref, text_sha256: sha, status: "not_permitted", detail: `LICENSE.md starts with ${JSON.stringify(normalized.slice(0, 80))}` };
}

/** Time for which a read license is kept. A read that failed is not kept. */
export const LICENSE_CACHE_TTL_MS = 5 * 60_000;
const LICENSE_CACHE_MAX = 256;
const cache = new Map<string, { expires: number; license: Promise<DatabaseLicense> }>();

export function clearLicenseCache(): void {
  cache.clear();
}

/** `readDatabaseLicense` with an in-memory cache per owner/database. */
export function cachedDatabaseLicense(owner: string, database: string): Promise<DatabaseLicense> {
  const key = `${owner}/${database}`.toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.license;
  cache.delete(key);
  if (cache.size >= LICENSE_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  const license = readDatabaseLicense(owner, database).then(read => {
    if (read.status === "unreadable" && cache.get(key)?.license === license) cache.delete(key);
    return read;
  });
  cache.set(key, { expires: now + LICENSE_CACHE_TTL_MS, license });
  return license;
}

export type CommercialDecision = { refusal: Refusal } | { license: ServedLicense };

function refusalTerms(license: DatabaseLicense): string {
  const served = `A database is served only under a license that permits commercial use (${LICENSE_IDS}) in its LICENSE.md.`;
  switch (license.status) {
    case "absent":
      return `it has no license (${license.detail}; ${license.source}). Without a license, the DoltHub terms permit use "through the DoltHub Service" only. ${served}`;
    case "not_permitted":
      return `its LICENSE.md is not a known form of a license that permits commercial use (${license.detail}; sha256 ${license.text_sha256}). ${served}`;
    default:
      return `its license could not be read (${license.detail}; ${license.source}), so the server cannot confirm that it permits commercial use. ${served}`;
  }
}

/** The rule for one database: the permitted license, or a refusal. Only the license is read. */
export async function commercialDatabaseDecision(owner: string, database: string): Promise<CommercialDecision> {
  const license = await cachedDatabaseLicense(owner, database);
  const terms = license.status === "permitted" && license.id ? COMMERCIAL_USE_LICENSES.get(license.id) : undefined;
  if (terms && license.id) return { license: { ...license, status: "permitted", id: license.id, name: terms.name, conditions: terms.conditions } };
  return { refusal: commercialUseRefusal(`The DoltHub database ${owner}/${database}`, refusalTerms(license)) };
}

const NAME = "[A-Za-z0-9_-]{1,100}";
const V2_ROUTE = new RegExp(`^/api/v2/databases/(${NAME})/(${NAME})(?:/(?:branches|tags|forks|releases|sql))?$`);
const LEGACY_ROUTE = new RegExp(`^/?(${NAME})/(${NAME})$`);

/** The database of an adapter path, by the same routes as `createDoltHubApiFetch`. Undefined for each other path. */
export function databaseOfPath(path: string): { owner: string; database: string } | undefined {
  const match = (path.startsWith("/api/") ? V2_ROUTE : LEGACY_ROUTE).exec(path);
  return match ? { owner: match[1], database: match[2] } : undefined;
}

/**
 * SQL forms that read a revision other than the branch of the request
 * (coordinator decision 2026-11-10, fail closed). The match is on the raw text
 * and on the text without comments, also inside string literals. `dolt_diff`
 * also covers the `dolt_diff_<table>` tables and `dolt_diff_stat`/`_summary`.
 * Any `@` is refused, as an approximation of a `@` revision qualifier, and a
 * quoted name with `/` is refused as a `database/branch` qualifier.
 */
const REVISION_SQL: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bAS\s+OF\b/i, "AS OF"],
  [/dolt_diff/i, "dolt_diff"],
  [/dolt_history_/i, "dolt_history_"],
  [/dolt_commit_diff_/i, "dolt_commit_diff_"],
  [/dolt_patch/i, "dolt_patch"],
  [/dolt_query_diff/i, "dolt_query_diff"],
  [/dolt_schema_diff/i, "dolt_schema_diff"],
  [/dolt_preview_merge/i, "dolt_preview_merge"],
  [/@/, "a @ revision qualifier"],
  [/`[^`]*\/[^`]*`/, "a database/branch revision qualifier"],
];

/** The revision form that `sql` uses, or undefined when it reads only the branch of the request. */
export function sqlRevisionReason(sql: string): string | undefined {
  const withoutComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(?:--|#)[^\n]*/g, " ");
  for (const text of [sql, withoutComments]) {
    const hit = REVISION_SQL.find(([pattern]) => pattern.test(text));
    if (hit) return hit[1];
  }
  return undefined;
}

const text = (value: unknown) => (value === undefined || value === null ? undefined : String(value));

/** The ref and the SQL of an adapter request, by the same parameters as `createDoltHubApiFetch`. */
function requestRevision(request: DoltRequest): { ref?: string; sql?: string } {
  if (!request.path.endsWith("/sql") || !request.path.startsWith("/api/")) {
    return { ref: request.params?.ref ? String(request.params.ref) : undefined, sql: text(request.params?.q) };
  }
  const input = request.method === "POST" && request.body && typeof request.body === "object"
    ? request.body as Record<string, unknown> : request.params ?? {};
  return { ref: text(input.ref), sql: text(input.q) };
}

/** Why a request reads a revision other than the default branch `ref` whose license was read; undefined when it does not. */
export function requestRevisionReason(request: DoltRequest, ref: string | null): string | undefined {
  const revision = requestRevision(request);
  if (revision.ref !== undefined && revision.ref !== ref) return `the ref ${JSON.stringify(revision.ref.slice(0, 100))}`;
  return revision.sql === undefined ? undefined : sqlRevisionReason(revision.sql);
}

export function revisionRefusal(database: string, ref: string | null, reason: string): Refusal {
  return commercialUseRefusal(`The request on DoltHub database ${database}`,
    `it reads ${reason}. Only the default branch${ref ? ` (${ref})` : ""}, whose LICENSE.md was checked, is served: no other ref, AS OF, dolt_diff, dolt_history_, dolt_commit_diff_ or revision qualifier.`);
}

/** The rule for an adapter request of a reselling caller. Each route names one database; a path without one is refused. */
export async function commercialRequestDecision(request: DoltRequest): Promise<CommercialDecision> {
  const target = databaseOfPath(request.path);
  if (!target) {
    return { refusal: commercialUseRefusal(`The path ${JSON.stringify(request.path.slice(0, 200))}`,
      "it names no DoltHub database (/{owner}/{database} or /api/v2/databases/{owner}/{database}), so its license cannot be read.") };
  }
  const decision = await commercialDatabaseDecision(target.owner, target.database);
  if ("refusal" in decision) return decision;
  const reason = requestRevisionReason(request, decision.license.ref);
  return reason ? { refusal: revisionRefusal(decision.license.database, decision.license.ref, reason) } : decision;
}

/** The value of `database_license` for a database in a listing: a listing reads no license. */
export const UNREAD_LISTED_LICENSE = {
  id: null,
  status: "unknown",
  note: "A listing reads no license. Before it serves the data or metadata of a database, the server reads its LICENSE.md and serves it only under a license that permits commercial use.",
} as const;
