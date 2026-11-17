import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  readServer, decide, buildCandidate, pickBase, waVersionFor, computeHashForVersion,
} from "../scripts/watch/candidate.mjs";
import { computeProtoHash } from "../scripts/vendor-proto.mjs";
import { validateAdapterFile } from "../src/catalog/schema.mjs";
import { ADAPTERS } from "../src/adapters/index.mjs";

const page = (hash, rel) => `<html><meta name="wa-api-version" content="${hash}"><body>${rel}</body></html>`;
const fakeHome = (map) => async (url) => {
  const body = map[new URL(url).host];
  return body === undefined ? { ok: false, status: 503 } : { ok: true, status: 200, text: async () => body };
};

test("readServer reads production and staging home pages", async () => {
  const fetch = fakeHome({
    "play.workadventu.re": page("aaaaaaaa", "v1.34.5"),
    "play.staging.workadventu.re": page("bbbbbbbb", "master@118dd84cdeadbeef"),
  });
  assert.deepEqual(await readServer("production", { fetch }), { hash: "aaaaaaaa", release: "v1.34.5" });
  assert.deepEqual(await readServer("staging", { fetch }), { hash: "bbbbbbbb", release: "master@118dd84cdeadbeef" });
  assert.equal(await readServer("production", { fetch: fakeHome({}) }), null);
  assert.throws(() => readServer("moon"), /unknown target/);
});

const index = (entries) => ({ schema: 1, entries });
const ok = (server, version, file) => ({ status: "ok", server, version, file, sha256: "0".repeat(64) });

test("decide: new hash gates; ok hash skips", () => {
  const ci = index({ aaaaaaaa: ok("production", "v1.34.4", "adapters/aaaaaaaa.json") });
  assert.equal(decide({ hash: "bbbbbbbb", server: "production", version: "v1.34.5", catalogIndex: ci }).action, "gate");
  assert.equal(decide({ hash: "aaaaaaaa", server: "production", version: "v1.34.4", catalogIndex: ci, force: true }).action, "skip");
});

test("decide: needs-attention skips unless force, main moved, or version changed", () => {
  const ci = index({
    cccccccc: { status: "needs-attention", server: "production", version: "v1.34.5", commit: "abc123" },
  });
  const base = { hash: "cccccccc", server: "production", version: "v1.34.5", catalogIndex: ci, codeFingerprint: "abc123" };
  assert.equal(decide(base).action, "skip");
  assert.equal(decide({ ...base, force: true }).action, "gate");
  assert.equal(decide({ ...base, codeFingerprint: "def456" }).action, "gate");
  assert.equal(decide({ ...base, version: "v1.34.6" }).action, "gate");
  // no known main commit: that trigger cannot fire
  assert.equal(decide({ ...base, codeFingerprint: undefined }).action, "skip");
});

const prodFile = {
  schema: 1, id: "wa-1.34.4", waVersion: "1.34.4", apiVersionHash: "f4cfe455", server: "production",
  protoFamily: "wa-1.34", meeting: { areaDwellMs: 0, areaLingerMs: 0 }, movement: { walkPxPerS: 180, runPxPerS: 460 },
};
const catalog = index({
  "23c8eb8c": ok("production", "v1.34.0", "adapters/23c8eb8c.json"),
  f4cfe455: ok("production", "v1.34.4", "adapters/f4cfe455.json"),
  "62e25483": ok("production", "v1.34.2", "adapters/62e25483.json"),
  d2d82672: ok("staging", "master@118dd84c", "adapters/d2d82672.json"),
});
const fetchBase = async (hash) =>
  hash === "f4cfe455"
    ? { ok: true, file: prodFile }
    : { ok: true, file: { schema: 1, id: "wa-master-118dd84c", waVersion: "master-118dd84c", apiVersionHash: hash, server: "staging", protoFamily: "wa-master", meeting: { areaDwellMs: 1500, areaLingerMs: 2500 } } };

test("pickBase takes the newest ok production release", () => {
  assert.equal(pickBase(catalog, "production").hash, "f4cfe455");
  assert.equal(pickBase(catalog, "staging").hash, "d2d82672");
  assert.equal(pickBase(index({}), "production"), null);
});

test("buildCandidate: production copies numbers and family, passes the schema", async () => {
  const r = await buildCandidate({ hash: "11112222", version: "v1.34.5", server: "production", catalogIndex: catalog, fetchBase });
  assert.equal(r.ok, true);
  assert.equal(r.base, "f4cfe455");
  assert.equal(r.file.waVersion, "1.34.5");
  assert.equal(r.file.id, "wa-1.34.5");
  assert.equal(r.file.apiVersionHash, "11112222");
  assert.equal(r.file.protoFamily, "wa-1.34");
  assert.deepEqual(r.file.movement, { walkPxPerS: 180, runPxPerS: 460 });
  assert.equal(validateAdapterFile(r.file, ADAPTERS).ok, true);
});

test("buildCandidate: staging is named master-<sha8>", async () => {
  const r = await buildCandidate({ hash: "33334444", version: "master@abcdef0123456789", server: "staging", catalogIndex: catalog, fetchBase });
  assert.equal(r.ok, true);
  assert.equal(r.file.waVersion, "master-abcdef01");
  assert.equal(r.file.server, "staging");
  assert.deepEqual(r.file.meeting, { areaDwellMs: 1500, areaLingerMs: 2500 });
  assert.equal(waVersionFor("staging", "master@118dd84c"), "master-118dd84c");
});

test("buildCandidate: staging without a base falls back to wa-master; production without one fails", async () => {
  const empty = index({});
  const s = await buildCandidate({ hash: "33334444", version: "master@abcdef0", server: "staging", catalogIndex: empty, fetchBase });
  assert.equal(s.ok, true);
  assert.equal(s.file.protoFamily, "wa-master");
  const p = await buildCandidate({ hash: "11112222", version: "v1.34.5", server: "production", catalogIndex: empty, fetchBase });
  assert.equal(p.ok, false);
});

test("buildCandidate: bad version name or unreadable base is a reason, not a throw", async () => {
  assert.equal((await buildCandidate({ hash: "11112222", version: "weird", server: "production", catalogIndex: catalog, fetchBase })).ok, false);
  const r = await buildCandidate({ hash: "11112222", version: "v1.34.5", server: "production", catalogIndex: catalog, fetchBase: async () => ({ ok: false, reason: "HTTP 500" }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 500/);
});

// --- computeProtoHash with a fake GitHub ---
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
function fakeGithub(seen) {
  const proto = "syntax = 'proto3';";
  const files = { "a.ts": "A", "b.ts": "B" };
  return async (url, opts) => {
    seen.push({ url, auth: opts.headers.authorization });
    const json = (o) => ({ ok: true, json: async () => o });
    if (url.includes("/commits/")) return json({ sha: "0123456789abcdef0123" });
    if (url.includes("/contents/")) return json(Object.keys(files).map((name) => ({ name, type: "file" })));
    if (url.endsWith("messages.proto")) return { ok: true, arrayBuffer: async () => Buffer.from(proto) };
    const f = url.split("/").pop();
    return { ok: true, arrayBuffer: async () => Buffer.from(files[f]) };
  };
}

test("computeProtoHash follows WorkAdventure's recipe and sends the token", async () => {
  const seen = [];
  const r = await computeProtoHash("v1.34.5", { token: "tok", fetch: fakeGithub(seen) });
  const inner =
    `${sha1("syntax = 'proto3';")}  protos/messages.proto\n` +
    `${sha1("A")}  ../libs/messages/src/JsonMessages/a.ts\n` +
    `${sha1("B")}  ../libs/messages/src/JsonMessages/b.ts\n`;
  assert.equal(r.apiVersionHash, sha1(inner).slice(0, 8));
  assert.equal(r.shortSha, "01234567");
  assert.ok(seen.every((s) => s.auth === "Bearer tok"));
  const seen2 = [];
  const st = await computeHashForVersion("staging", "master@118dd84c", { token: "", fetch: fakeGithub(seen2) });
  assert.match(seen2[0].url, /\/commits\/118dd84c/);
  assert.ok(seen2.every((s) => s.auth === undefined));
  assert.equal(st.apiVersionHash.length, 8);
  assert.throws(() => computeHashForVersion("staging", null, {}), /master@<sha>/);
  assert.throws(() => computeHashForVersion("staging", "v1.34.5", {}), /master@<sha>/);
});

test("waVersionFor returns null for a missing or odd version", () => {
  assert.equal(waVersionFor("staging", null), null);
  assert.equal(waVersionFor("production", undefined), null);
});

test("decide: a long master sha matches the stored 8-hex placeholder version", () => {
  const ci = index({
    dddddddd: { status: "needs-attention", server: "staging", version: "master@118dd84c", commit: "abc" },
  });
  const r = decide({ hash: "dddddddd", server: "staging", version: "master@118dd84c" + "0".repeat(32), catalogIndex: ci, codeFingerprint: "abc" });
  assert.equal(r.action, "skip");
  const r2 = decide({ hash: "dddddddd", server: "staging", version: "master@99999999aaaa", catalogIndex: ci, codeFingerprint: "abc" });
  assert.equal(r2.action, "gate");
  const prod = index({ eeeeeeee: { status: "needs-attention", server: "production", version: "v1.34.5", commit: "abc" } });
  assert.equal(decide({ hash: "eeeeeeee", server: "production", version: "v1.34.5", catalogIndex: prod, codeFingerprint: "abc" }).action, "skip");
});

test("pickBase for staging sorts hash strings, not object order", () => {
  const ci = index({ "0abcdef0": ok("staging", "master@aaaaaaaa", "x"), "99999999": ok("staging", "master@bbbbbbbb", "y") });
  assert.equal(pickBase(ci, "staging").hash, "99999999");
  const ci2 = index({ abcdef00: ok("staging", "master@bbbbbbbb", "y"), "99999999": ok("staging", "master@aaaaaaaa", "x") });
  assert.equal(pickBase(ci2, "staging").hash, "abcdef00");
});

test("decide requires a server", () => {
  assert.throws(() => decide({ hash: "aaaaaaaa", version: "v1.34.5", catalogIndex: index({}) }), /server must be/);
});
