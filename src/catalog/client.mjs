// Fetch the adapter catalog: the index, then one adapter file. Everything here is
// downloaded from the internet, so it is treated as hostile: bounded time and size,
// no redirects, the file URL must stay on the index's origin, the bytes must match
// the sha256 the index promises, and the parsed file must pass the strict schema.
// Nothing throws; every failure is { ok: false, reason }.

import { createHash } from "node:crypto";
import { HASH_RE, validateAdapterFile } from "./schema.mjs";

export const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/campey/workadventurer/main/catalog/index.json";
export const MAX_INDEX_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const SHA256_RE = /^[0-9a-f]{64}$/;

const bad = (reason) => ({ ok: false, reason });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const errText = (e) => (e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out" : (e?.message ?? String(e)));

export function catalogUrl(env = process.env) {
  return env.WA_CATALOG_URL || DEFAULT_CATALOG_URL;
}

/**
 * GET a URL and read at most maxBytes of the body, as raw bytes. The one timeout
 * covers the headers and the body read. Redirects are refused, a Content-Length over
 * the cap is rejected before reading, and the stream is cancelled the moment the
 * running total passes the cap.
 */
async function getCapped(url, { fetch: doFetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes }) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await doFetch(url, { signal, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) return bad(`unexpected redirect (HTTP ${res.status})`);
    if (res.type === "opaqueredirect") return bad("unexpected redirect");
    if (!res.ok) return bad(`HTTP ${res.status}`);
    if (res.url && new URL(res.url).origin !== new URL(url).origin) return bad("response came from a different origin");
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return bad(`body too large (size ${declared} bytes, limit ${maxBytes})`);
    if (!res.body) return bad("empty response");
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        return bad(`body too large (size over ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
  } catch (e) {
    return bad(errText(e));
  }
}

function parseJson(bytes) {
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { error: "not valid JSON" };
  }
}

export async function fetchIndex({ url = catalogUrl(), fetch, timeoutMs } = {}) {
  const got = await getCapped(url, { fetch, timeoutMs, maxBytes: MAX_INDEX_BYTES });
  if (!got.ok) return bad(`index: ${got.reason}`);
  const parsed = parseJson(got.bytes);
  if (parsed.error) return bad(`index: ${parsed.error}`);
  const raw = parsed.value;
  if (!isObj(raw) || raw.schema !== 1) return bad("index: schema must be 1");
  if (!isObj(raw.entries)) return bad("index: entries must be an object");
  // Keep only entries we could trust. "ok" needs a file path and a real sha256;
  // "needs-attention" is a placeholder with no usable file (any file/sha256 it carries
  // is stripped, so it can never be fetched as an adapter); other statuses are dropped.
  const entries = {};
  for (const [hash, e] of Object.entries(raw.entries)) {
    if (!HASH_RE.test(hash) || !isObj(e)) continue;
    if (e.status === "needs-attention") {
      const { file, sha256, ...rest } = e;
      entries[hash] = rest;
    } else if (e.status === "ok" && typeof e.file === "string" && typeof e.sha256 === "string" && SHA256_RE.test(e.sha256)) {
      entries[hash] = e;
    }
  }
  return { ok: true, url, index: { ...raw, entries } };
}

export async function fetchAdapterFile({ indexUrl, hash, entry, builtins, fetch, timeoutMs }) {
  let fileUrl;
  try {
    if (!isObj(entry) || typeof entry.file !== "string") return bad("entry has no file");
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) return bad("entry sha256 is malformed");
    fileUrl = new URL(entry.file, indexUrl);
    if (fileUrl.origin !== new URL(indexUrl).origin) return bad(`file URL is not on the index's origin (${fileUrl.origin})`);
  } catch {
    return bad("file URL is invalid");
  }
  const got = await getCapped(fileUrl.href, { fetch, timeoutMs, maxBytes: MAX_FILE_BYTES });
  if (!got.ok) return bad(`adapter ${hash}: ${got.reason}`);
  if (createHash("sha256").update(got.bytes).digest("hex") !== entry.sha256) {
    return bad(`adapter ${hash}: sha256 does not match the index`);
  }
  const parsed = parseJson(got.bytes);
  if (parsed.error) return bad(`adapter ${hash}: ${parsed.error}`);
  const checked = validateAdapterFile(parsed.value, builtins);
  if (!checked.ok) return bad(`adapter ${hash}: ${checked.reason}`);
  if (checked.file.apiVersionHash !== hash) return bad(`adapter ${hash}: file's apiVersionHash is ${checked.file.apiVersionHash}`);
  return { ok: true, text: got.bytes.toString("utf8"), file: checked.file };
}
