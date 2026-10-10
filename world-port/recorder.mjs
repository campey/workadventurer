// Records the live client's HTTP + WebSocket traffic at the driven-port seam
// (WorkAdventureClient's `fetch` / `WebSocketImpl` options).
//
// Recordings can hold other people's names and chat. world-port/recordings/ is
// git-ignored; only output of redact() belongs in recordings/redacted/.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RECORDINGS_DIR = path.join(here, "recordings");

const b64 = (d) => {
  if (d == null) return undefined;
  if (typeof d === "string") return Buffer.from(d).toString("base64");
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString("base64");
  if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString("base64");
  if (Array.isArray(d)) return Buffer.concat(d.map((x) => Buffer.from(x))).toString("base64");
  return undefined;
};

/** Wrap `fetch` and `WebSocketImpl`; every exchange is pushed onto `sink`. */
export function record({ fetch, WebSocketImpl }, sink) {
  const t0 = Date.now();
  const push = (e) => sink.push({ t: Date.now() - t0, ...e });

  const recFetch = async (url, init = {}) => {
    push({ port: "http", dir: "out", url: String(url), bytes: b64(init.body) });
    const res = await fetch(url, init);
    let bytes;
    try { bytes = b64(await res.clone().arrayBuffer()); } catch { /* body unreadable: record status only */ }
    push({ port: "http", dir: "in", url: String(url), status: res.status, bytes });
    return res;
  };

  class RecWS extends WebSocketImpl {
    constructor(url, ...rest) {
      super(url, ...rest);
      push({ port: "ws", dir: "out", url: String(url) }); // connect; the token subprotocol is not recorded
    }
    send(data, ...rest) {
      push({ port: "ws", dir: "out", bytes: b64(data) });
      return super.send(data, ...rest);
    }
    on(ev, fn) {
      if (ev !== "message") return super.on(ev, fn);
      return super.on(ev, (data, ...rest) => {
        push({ port: "ws", dir: "in", bytes: b64(data) });
        return fn(data, ...rest);
      });
    }
  }
  return { fetch: recFetch, WebSocketImpl: RecWS };
}

const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const AUTH = /("authToken"\s*:\s*")[^"]*(")/g;
const SENSITIVE_KEYS = new Set(["name", "message", "text", "authToken"]);

// Names and chat text found in `decoded` payloads (recorder-decoded messages).
function collectSecrets(node, out) {
  if (Array.isArray(node)) node.forEach((n) => collectSecrets(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (SENSITIVE_KEYS.has(k) && typeof v === "string" && v.length >= 3) out.add(v); // short values would mangle everything
      else collectSecrets(v, out);
    }
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Copy of `entries` with tokens, JWTs, uuids, names and chat text blanked. */
export function redact(entries) {
  const secrets = new Set();
  for (const e of entries) collectSecrets(e.decoded, secrets);
  const words = [...secrets].sort((a, b) => b.length - a.length);
  const wordRe = words.length ? new RegExp(words.map(escapeRe).join("|"), "g") : null;

  const scrub = (s) => {
    s = s.replace(AUTH, "$1<redacted>$2").replace(JWT, "<redacted>").replace(UUID, "<redacted>");
    return wordRe ? s.replace(wordRe, "<redacted>") : s;
  };
  // Payload bytes: blank matches with same-length filler so frame lengths stay valid.
  const scrubBytes = (b) => {
    const text = Buffer.from(b, "base64").toString("latin1");
    const fill = (m) => "x".repeat(m.length);
    let t = text.replace(AUTH, (m, a, z) => a + "x".repeat(m.length - a.length - z.length) + z)
      .replace(JWT, fill).replace(UUID, fill);
    if (wordRe) t = t.replace(wordRe, fill);
    return Buffer.from(t, "latin1").toString("base64");
  };
  const walk = (v) => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) =>
        [k, SENSITIVE_KEYS.has(k) && typeof x === "string" ? "<redacted>" : walk(x)]));
    }
    return v;
  };
  return entries.map((e) => {
    const { bytes, decoded, ...rest } = e;
    const out = walk(rest);
    // ws frames are protobuf: names/chat sit in the bytes, so drop them and keep the length.
    if (e.port === "ws" && bytes != null) {
      out.bytes = "<redacted>";
      out.length = Buffer.from(bytes, "base64").length;
    } else if (bytes != null) out.bytes = scrubBytes(bytes);
    if (decoded !== undefined) out.decoded = walk(decoded);
    return out;
  });
}

/** Write entries as JSONL to recordings/<name>-<ISO time>.jsonl; returns the path. */
export function save(entries, name) {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const file = path.join(RECORDINGS_DIR, `${name}-${stamp}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}
