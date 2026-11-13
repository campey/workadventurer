import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ADAPTERS, matchVersion } from "../src/adapters/index.mjs";
import { recoverAdapter, refusalMessage } from "../src/catalog/recover.mjs";
import { cachedHashes } from "../src/catalog/store.mjs";
import { REFUSED_EXIT } from "../src/supervise.mjs";

const WA = fileURLToPath(new URL("../bin/wa.mjs", import.meta.url));
const builtins = ADAPTERS;
const family = Object.keys(ADAPTERS)[0];
const HASH = "abcdef12";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const adapterText = () =>
  JSON.stringify({ schema: 1, id: "wa-test", waVersion: "1.99", apiVersionHash: HASH, server: "production", protoFamily: family });
const text = adapterText();
const page = (hash, rel = "v1.99.0") => `<html><head>${hash ? `<meta name="wa-api-version" content="${hash}">` : ""}</head><body>${rel}</body></html>`;

const handlers = new Map();
const seen = [];
const sockets = new Set();
const server = http.createServer((req, res) => {
  seen.push(req.url);
  const h = handlers.get(req.url);
  if (!h) { res.writeHead(404); res.end("nope"); return; }
  h(req, res);
});
server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { for (const s of sockets) s.destroy(); server.close(); });
const serve = (p, body, type = "application/json") => handlers.set(p, (req, res) => { res.writeHead(200, { "content-type": type }); res.end(body); });
const setup = ({ hash = HASH, entry, rel } = {}) => {
  handlers.clear(); seen.length = 0;
  serve("/", page(hash, rel), "text/html");
  serve("/catalog/index.json", JSON.stringify({ schema: 1, updated: "x", entries: entry ? { [HASH]: entry } : {} }));
  serve(`/catalog/adapters/${HASH}.json`, text);
};
const okEntry = (over = {}) => ({ status: "ok", server: "production", version: "1.99", file: `adapters/${HASH}.json`, sha256: sha(text), ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wa-recover-"));
const boom = async () => { throw new Error("ask must not be called"); };
const run = (over = {}) => recoverAdapter({
  roomUrl: base + "/room", mode: "auto", indexUrl: `${base}/catalog/index.json`, dir: tmp(), builtins, matchRelease: matchVersion, timeoutMs: 1500, ...over,
});

test("auto: downloads, verifies, caches and applies without asking", async () => {
  setup({ entry: okEntry() });
  const dir = tmp();
  const o = await run({ dir, ask: boom });
  assert.equal(o.status, "applied");
  assert.equal(o.hash, HASH);
  assert.equal(o.adapter.id, "wa-test");
  assert.deepEqual([...(await cachedHashes({ dir }))], [HASH]);
});

test("known: a built-in hash makes zero index requests", async () => {
  const builtinHash = Object.values(ADAPTERS).flatMap((a) => a.apiVersionHashes ?? [])[0];
  setup({ hash: builtinHash, entry: okEntry() });
  const o = await run({ ask: boom });
  assert.deepEqual(o, { status: "known", hash: builtinHash });
  assert.equal(seen.some((u) => u.startsWith("/catalog")), false);
});

test("known: an already-cached hash", async () => {
  setup({ entry: okEntry() });
  const dir = tmp();
  assert.equal((await run({ dir })).status, "applied");
  seen.length = 0;
  assert.deepEqual(await run({ dir }), { status: "known", hash: HASH });
  assert.equal(seen.some((u) => u.startsWith("/catalog")), false);
});

test("unsupported/no-entry", async () => {
  setup({});
  const o = await run();
  assert.deepEqual(o, { status: "unsupported", hash: HASH, reason: "no-entry" });
  assert.match(refusalMessage(o), /no adapter for this server version yet/);
});

test("unsupported/needs-attention carries the gate detail", async () => {
  setup({ entry: { status: "needs-attention", gate: "proto drift", issue: 99 } });
  const o = await run();
  assert.equal(o.status, "unsupported");
  assert.equal(o.reason, "needs-attention");
  assert.match(o.detail, /proto drift/);
  assert.match(refusalMessage(o), /this server version isn't supported yet, it needs attention/);
  assert.match(refusalMessage(o), /proto drift/);
});

test("needs-attention with an object gate still gives a string detail", async () => {
  setup({ entry: { status: "needs-attention", gate: { step: "selfcheck", ok: false } } });
  const o = await run();
  assert.equal(typeof o.detail, "string");
  assert.match(o.detail, /selfcheck/);
});

test("never: mode never with an available adapter", async () => {
  setup({ entry: okEntry() });
  const dir = tmp();
  const o = await run({ mode: "never", dir, ask: boom });
  assert.deepEqual(o, { status: "never", hash: HASH });
  assert.match(refusalMessage(o), /WA_ADAPTER_UPDATES=auto/);
  assert.equal((await cachedHashes({ dir })).size, 0);
});

test("ask: no -> declined, cache empty", async () => {
  setup({ entry: okEntry() });
  const dir = tmp();
  let q;
  const o = await run({ mode: "ask", dir, ask: async (s) => { q = s; return "no"; } });
  assert.deepEqual(o, { status: "declined", hash: HASH });
  assert.match(q, /v1\.99\.0/);
  assert.match(q, /download/i);
  assert.equal((await cachedHashes({ dir })).size, 0);
});

test("ask: yes fills the cache", async () => {
  setup({ entry: okEntry() });
  const dir = tmp();
  const o = await run({ mode: "ask", dir, ask: async () => "yes" });
  assert.equal(o.status, "applied");
  assert.equal((await cachedHashes({ dir })).has(HASH), true);
});

test("ask: always calls onAlways exactly once and applies", async () => {
  setup({ entry: okEntry() });
  let n = 0;
  const o = await run({ mode: "ask", ask: async () => "always", onAlways: () => { n++; } });
  assert.equal(o.status, "applied");
  assert.equal(n, 1);
});

test("ask mode with no ask function counts as no", async () => {
  setup({ entry: okEntry() });
  const dir = tmp();
  const o = await run({ mode: "ask", dir });
  assert.equal(o.status, "declined");
  assert.equal((await cachedHashes({ dir })).size, 0);
});

test("a throwing onAlways does not stop the recovery", async () => {
  setup({ entry: okEntry() });
  const o = await run({ mode: "ask", ask: async () => "always", onAlways: () => { throw new Error("config untrustworthy"); } });
  assert.equal(o.status, "applied");
});

test("unavailable: catalog 404 fast", async () => {
  setup({ entry: okEntry() });
  handlers.delete("/catalog/index.json");
  const t = Date.now();
  const o = await run({ timeoutMs: 500 });
  assert.equal(o.status, "unavailable");
  assert.ok(Date.now() - t < 2000);
});

test("unavailable: page has no hash tag", async () => {
  setup({ hash: null, entry: okEntry() });
  assert.equal((await run()).status, "unavailable");
});

test("unavailable: room unreachable", async () => {
  setup({ entry: okEntry() });
  assert.equal((await run({ roomUrl: "http://127.0.0.1:1/room" })).status, "unavailable");
});

test("unavailable: tampered adapter file, nothing cached", async () => {
  setup({ entry: okEntry({ sha256: sha("something else") }) });
  const dir = tmp();
  const o = await run({ dir });
  assert.equal(o.status, "unavailable");
  assert.equal((await cachedHashes({ dir })).size, 0);
});

test("process: wa join with no TTY and mode ask exits 4 and says how to allow it", async () => {
  setup({ entry: okEntry() });
  const home = tmp();
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const freePort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const child = spawn(process.execPath, [WA, "join"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
      WA_ROOM: base + "/room", WA_CATALOG_URL: `${base}/catalog/index.json`,
      WA_ADAPTER_UPDATES: "ask", WA_DAEMON_PORT: String(freePort),
      WA_VERSION: "", WA_TARGET: "auto",
    },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const code = await new Promise((r) => child.on("exit", r));
  clearTimeout(timer);
  assert.equal(code, REFUSED_EXIT, out);
  assert.match(out, /WA_ADAPTER_UPDATES=auto/);
  assert.equal(fs.existsSync(path.join(home, ".workadventurer", "adapters")), false);
});
