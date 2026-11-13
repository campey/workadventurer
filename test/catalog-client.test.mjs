import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { ADAPTERS } from "../src/adapters/index.mjs";
import { DEFAULT_CATALOG_URL, catalogUrl, fetchAdapterFile, fetchIndex } from "../src/catalog/client.mjs";

const builtins = ADAPTERS;
const family = Object.keys(ADAPTERS)[0];
const HASH = "abcdef12";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const adapterText = (over = {}) =>
  JSON.stringify({ schema: 1, id: "wa-test", waVersion: "1.99", apiVersionHash: HASH, server: "production", protoFamily: family, ...over });
const indexText = (entries, over = {}) => JSON.stringify({ schema: 1, updated: "2026-11-10T00:00:00Z", entries, ...over });
const entryFor = (text, over = {}) => ({ status: "ok", server: "production", version: "1.99", file: `adapters/${HASH}.json`, sha256: sha(text), ...over });

// One server, routes registered per test; `handlers` maps path -> (req, res).
const handlers = new Map();
const sockets = new Set();
const server = http.createServer((req, res) => {
  const h = handlers.get(req.url);
  if (!h) { res.writeHead(404); res.end("nope"); return; }
  h(req, res);
});
server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { for (const s of sockets) s.destroy(); server.close(); });
const serve = (path, body, type = "application/json", status = 200) =>
  handlers.set(path, (req, res) => { res.writeHead(status, { "content-type": type }); res.end(body); });

test("catalogUrl honours WA_CATALOG_URL and falls back to the default", () => {
  assert.equal(catalogUrl({ WA_CATALOG_URL: "http://example.test/i.json" }), "http://example.test/i.json");
  assert.equal(catalogUrl({}), DEFAULT_CATALOG_URL);
  assert.match(DEFAULT_CATALOG_URL, /^https:\/\/raw\.githubusercontent\.com\/campey\/workadventurer\/main\/catalog\/index\.json$/);
});

test("happy path: index then adapter file", async () => {
  const text = adapterText();
  serve("/ok/index.json", indexText({ [HASH]: entryFor(text) }));
  serve(`/ok/adapters/${HASH}.json`, text);
  const idx = await fetchIndex({ url: `${base}/ok/index.json` });
  assert.equal(idx.ok, true);
  assert.equal(idx.index.entries[HASH].sha256, sha(text));
  const f = await fetchAdapterFile({ indexUrl: idx.url, hash: HASH, entry: idx.index.entries[HASH], builtins });
  assert.equal(f.ok, true);
  assert.equal(f.text, text);
  assert.equal(f.file.id, "wa-test");
});

test("index: 404, HTML, schema 2, missing entries, array entries all fail without throwing", async () => {
  serve("/i/html", "<html>hi</html>", "text/html");
  serve("/i/s2", indexText({}, { schema: 2 }));
  serve("/i/noentries", JSON.stringify({ schema: 1 }));
  serve("/i/arr", JSON.stringify({ schema: 1, entries: [] }));
  for (const p of ["/i/missing", "/i/html", "/i/s2", "/i/noentries", "/i/arr"]) {
    const r = await fetchIndex({ url: base + p });
    assert.equal(r.ok, false, p);
    assert.equal(typeof r.reason, "string");
  }
});

test("index: non-hash keys and entries with a bad sha256 are dropped", async () => {
  const text = adapterText();
  serve("/i/mixed", indexText({
    [HASH]: entryFor(text),
    "../evil": entryFor(text),
    ABCDEF12: entryFor(text),
    "11111111": entryFor(text, { sha256: "ABC" }),
    "22222222": entryFor(text, { sha256: sha(text).toUpperCase() }),
    "33333333": entryFor(text, { file: 5 }),
    "44444444": null,
  }));
  const r = await fetchIndex({ url: `${base}/i/mixed` });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.index.entries), [HASH]);
});

test("index: unreachable server and a bad URL return ok:false", async () => {
  assert.equal((await fetchIndex({ url: "http://127.0.0.1:1/x" })).ok, false);
  assert.equal((await fetchIndex({ url: "not a url" })).ok, false);
});

test("index: a hanging server times out", async () => {
  handlers.set("/hang", () => {});
  const t = Date.now();
  const r = await fetchIndex({ url: `${base}/hang`, timeoutMs: 100 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /time|abort/i);
  assert.ok(Date.now() - t < 3000);
});

test("index: a body that stalls after the headers times out too", async () => {
  handlers.set("/stall", (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
  const r = await fetchIndex({ url: `${base}/stall`, timeoutMs: 150 });
  assert.equal(r.ok, false);
});

// Streams 64 KiB chunks until the client goes away; records how much it got out.
function endless(path, state) {
  handlers.set(path, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const pump = () => {
      if (res.destroyed || res.writableEnded) return;
      state.sent += chunk.length;
      if (res.write(chunk)) setImmediate(pump); else res.once("drain", pump);
    };
    res.on("close", () => { state.closed = true; });
    pump();
  });
}

test("index: an oversized body (no Content-Length) is cut off at the cap, not buffered", async () => {
  const state = { sent: 0, closed: false };
  endless("/big-index", state);
  const r = await fetchIndex({ url: `${base}/big-index`, timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /size|large|bytes/i);
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(state.sent < 16 * 1024 * 1024, `server pushed ${state.sent} bytes`);
  assert.equal(state.closed, true);
});

test("index: a Content-Length over the cap is rejected up front", async () => {
  handlers.set("/cl-index", (req, res) => { res.writeHead(200, { "content-length": String(2 * 1024 * 1024) }); res.write("{"); });
  const r = await fetchIndex({ url: `${base}/cl-index`, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /size|large|bytes/i);
});

test("index: a redirect is not followed", async () => {
  handlers.set("/redir", (req, res) => { res.writeHead(302, { location: "/ok/index.json" }); res.end(); });
  const r = await fetchIndex({ url: `${base}/redir` });
  assert.equal(r.ok, false);
  assert.match(r.reason, /redirect/i);
});

test("adapter file: sha256 differing from the index fails", async () => {
  const text = adapterText();
  serve(`/sha/adapters/${HASH}.json`, text);
  const r = await fetchAdapterFile({ indexUrl: `${base}/sha/index.json`, hash: HASH, entry: entryFor(text, { sha256: sha("other") }), builtins });
  assert.equal(r.ok, false);
  assert.match(r.reason, /sha256/);
});

test("adapter file: apiVersionHash differing from the key fails", async () => {
  const text = adapterText({ apiVersionHash: "11111111" });
  serve(`/key/adapters/${HASH}.json`, text);
  const r = await fetchAdapterFile({ indexUrl: `${base}/key/index.json`, hash: HASH, entry: entryFor(text), builtins });
  assert.equal(r.ok, false);
  assert.match(r.reason, /hash/i);
});

test("adapter file: out-of-bounds data fails validation", async () => {
  const text = adapterText({ meeting: { areaDwellMs: 99999 } });
  serve(`/bad/adapters/${HASH}.json`, text);
  const r = await fetchAdapterFile({ indexUrl: `${base}/bad/index.json`, hash: HASH, entry: entryFor(text), builtins });
  assert.equal(r.ok, false);
  assert.match(r.reason, /areaDwellMs/);
});

test("adapter file: non-JSON with a matching sha256 fails", async () => {
  const text = "<html>";
  serve(`/nj/adapters/${HASH}.json`, text, "text/html");
  const r = await fetchAdapterFile({ indexUrl: `${base}/nj/index.json`, hash: HASH, entry: entryFor(text), builtins });
  assert.equal(r.ok, false);
});

test("adapter file: a BOM-prefixed body returns text without the BOM", async () => {
  const body = "\uFEFF" + adapterText();
  handlers.clear();
  serve(`/adapters/${HASH}.json`, Buffer.from(body, "utf8"));
  const r = await fetchAdapterFile({ indexUrl: `${base}/index.json`, hash: HASH, entry: entryFor(body, { file: `adapters/${HASH}.json` }), builtins });
  assert.equal(r.ok, true, r.reason);
  assert.notEqual(r.text.charCodeAt(0), 0xfeff);
  assert.doesNotThrow(() => JSON.parse(r.text));
});

test("adapter file: 404 and a hanging server fail", async () => {
  const text = adapterText();
  const r = await fetchAdapterFile({ indexUrl: `${base}/none/index.json`, hash: HASH, entry: entryFor(text), builtins });
  assert.equal(r.ok, false);
  handlers.set(`/h2/adapters/${HASH}.json`, () => {});
  const h = await fetchAdapterFile({ indexUrl: `${base}/h2/index.json`, hash: HASH, entry: entryFor(text), builtins, timeoutMs: 100 });
  assert.equal(h.ok, false);
});

test("adapter file: an entry whose file leaves the index origin is refused without fetching", async () => {
  const text = adapterText();
  let called = false;
  const fetch = async () => { called = true; throw new Error("should not fetch"); };
  for (const file of ["http://evil.test/a.json", "//evil.test/a.json", `${base.replace("127.0.0.1", "localhost")}/x.json`]) {
    const r = await fetchAdapterFile({ indexUrl: `${base}/o/index.json`, hash: HASH, entry: entryFor(text, { file }), builtins, fetch });
    assert.equal(r.ok, false, file);
    assert.match(r.reason, /origin/i);
  }
  assert.equal(called, false);
});

test("adapter file: a same-origin redirect is still not followed", async () => {
  const text = adapterText();
  handlers.set(`/r2/adapters/${HASH}.json`, (req, res) => { res.writeHead(302, { location: `/ok/adapters/${HASH}.json` }); res.end(); });
  const r = await fetchAdapterFile({ indexUrl: `${base}/r2/index.json`, hash: HASH, entry: entryFor(text), builtins });
  assert.equal(r.ok, false);
  assert.match(r.reason, /redirect/i);
});

test("adapter file: an entry with a malformed sha256 is refused", async () => {
  const text = adapterText();
  serve(`/ms/adapters/${HASH}.json`, text);
  const r = await fetchAdapterFile({ indexUrl: `${base}/ms/index.json`, hash: HASH, entry: entryFor(text, { sha256: "xyz" }), builtins });
  assert.equal(r.ok, false);
});

test("adapter file: an oversized body is cut off at the cap, not buffered", async () => {
  const state = { sent: 0, closed: false };
  endless(`/big/adapters/${HASH}.json`, state);
  const r = await fetchAdapterFile({ indexUrl: `${base}/big/index.json`, hash: HASH, entry: entryFor("x"), builtins, timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /size|large|bytes/i);
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(state.sent < 4 * 1024 * 1024, `server pushed ${state.sent} bytes`);
  assert.equal(state.closed, true);
});

test("index: a needs-attention placeholder is kept with its gate; file and sha256 are stripped", async () => {
  const text = adapterText();
  serve("/i/placeholder", indexText({
    "55555555": { status: "needs-attention", server: "staging", version: "master@abc", gate: "movement drifted", issue: 7 },
    "66666666": entryFor(text, { status: "needs-attention", gate: "g" }),
    "77777777": entryFor(text, { status: "ok", file: undefined }),
    "88888888": entryFor(text, { status: "garbage" }),
    [HASH]: entryFor(text),
  }));
  const r = await fetchIndex({ url: `${base}/i/placeholder` });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.index.entries).sort(), ["55555555", "66666666", HASH].sort());
  assert.equal(r.index.entries["55555555"].gate, "movement drifted");
  assert.equal(r.index.entries["55555555"].issue, 7);
  // Chosen: a needs-attention entry never carries a usable file, even if the index gave one.
  assert.equal("file" in r.index.entries["66666666"], false);
  assert.equal("sha256" in r.index.entries["66666666"], false);
  assert.equal(r.index.entries["66666666"].gate, "g");
  const f = await fetchAdapterFile({ indexUrl: r.url, hash: "66666666", entry: r.index.entries["66666666"], builtins });
  assert.equal(f.ok, false);
});
