import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import { flattenObject, type SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const row = (value: unknown, index: number): Row => ({
  ...(record(value) ? { ...flattenObject(value, 2), ...Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, item !== null && typeof item === "object" ? JSON.stringify(item) : item])) } : Array.isArray(value)
    ? { ...Object.fromEntries(value.map((cell, i) => [`c${i}`, cell])), cells: JSON.stringify(value) } : { value }),
  native_json: JSON.stringify(value), source_index: index,
});

/** Keep SQL cell order and source context; duplicate names never become object keys. */
export class DoltHubDataDO extends RestStagingDO {
  protected getTabularData(value: unknown): unknown {
    const data = record(value) && Array.isArray(value.content) && record(value.structuredContent) && "data" in value.structuredContent
      ? value.structuredContent.data : value;
    if (Array.isArray(data)) return { result: data.map(row) };
    if (!record(data)) return data;
    const sql = record(data.data) && Array.isArray(data.data.rows) ? data.data : data;
    if (Array.isArray(sql.rows)) {
      const { rows, ...queryContext } = sql;
      return { sql_rows: rows.map(row), ...(Array.isArray(sql.columns) ? { query_columns: sql.columns.map(row) } : {}),
        response_context: [{ native_json: JSON.stringify(sql === data ? queryContext : { ...data, data: queryContext }) }] };
    }
    const arrays = Object.entries(data).filter(([, value]) => Array.isArray(value));
    if (arrays.length) return { ...Object.fromEntries(arrays.map(([key, values]) => [key === "data" ? "resources" : `native_${key}`, (values as unknown[]).map(row)])),
      response_context: [{ native_json: JSON.stringify(Object.fromEntries(Object.entries(data).filter(([, value]) => !Array.isArray(value)))) }] };
    return { result: [row(data, 0)] };
  }
  protected getSchemaHints(value: unknown): SchemaHints {
    const tables = this.getTabularData(value);
    const columnTypes: Record<string, string> = { native_json: "TEXT", cells: "TEXT" };
    if (record(tables)) for (const values of Object.values(tables)) {
      if (!Array.isArray(values)) continue;
      for (const item of values) if (record(item)) for (const [key, value] of Object.entries(item)) {
        if (typeof value === "string") columnTypes[key] = "TEXT";
      }
    }
    return { columnTypes };
  }
}
