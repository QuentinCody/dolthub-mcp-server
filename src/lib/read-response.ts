export function fail(message: string, status = 400, data?: unknown): never {
  throw Object.assign(new Error(message), { status, data });
}

/** Bound headers separately at the caller; never wait for cancellation to finish. */
export async function readDoltResponse(response: Response, token?: string): Promise<string> {
  if (!response.body) fail("Empty DoltHub response", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const deadline = Date.now() + 15_000;
  let raw = "";
  let bytes = 0;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("DoltHub body exceeded its 15-second deadline"), { status: 504 })), Math.max(0, deadline - Date.now()));
      });
      const chunk = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4 * 1024 * 1024) fail("DoltHub response exceeds byte limit; narrow the query", 502);
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
    if (token) raw = raw.split(token).join("[REDACTED]");
    if (response.status === 206 || response.headers.has("content-range")) fail("Unexpected partial DoltHub response", 502,
      { response: raw, http_status: response.status, content_range: response.headers.get("content-range") });
    return raw;
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
