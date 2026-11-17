import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publish } from "../scripts/watch/publish.mjs";
import { createGithubPort, assertCatalogPaths } from "../scripts/watch/github-port.mjs";
import { fetchIndex } from "../src/catalog/client.mjs";
import { rebuildIndex } from "../scripts/catalog-index.mjs";

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "catalog");
const HASH = "abcdef01";

function tmpCatalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
  fs.mkdirSync(path.join(dir, "adapters"));
  fs.copyFileSync(path.join(SRC, "adapters", "23c8eb8c.json"), path.join(dir, "adapters", "23c8eb8c.json"));
  rebuildIndex(dir);
  return dir;
}
const adapter = (hash = HASH) => ({ ...JSON.parse(fs.readFileSync(path.join(SRC, "adapters", "23c8eb8c.json"), "utf8")), apiVersionHash: hash, waVersion: "1.34.5" });
const readIndex = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));

function fakePort({ mergeFails = 0, failAt } = {}) {
  const f = { branches: new Map(), prs: [], commits: [], calls: [], merged: [], mergeFails };
  f.mainCommit = async () => "a".repeat(40);
  f.createBranch = async (name, sha) => { f.calls.push("createBranch"); if (failAt === "createBranch") throw new Error("boom"); f.branches.set(name, sha); };
  f.commit = async ({ branch, message, files }) => { f.calls.push("commit"); assertCatalogPaths(files.map((x) => x.path)); f.commits.push({ branch, message, files }); };
  f.findOpenPr = async (branch) => f.prs.find((p) => p.branch === branch && !p.merged) ?? null;
  f.openPr = async ({ branch, title }) => { const p = { number: f.prs.length + 1, branch, title }; f.prs.push(p); return { number: p.number }; };
  f.merge = async (n) => { if (f.mergeFails > 0) { f.mergeFails--; throw new Error("405 not mergeable"); } f.prs.find((p) => p.number === n).merged = true; f.merged.push(n); return { merged: true }; };
  return f;
}

test("pass: writes the adapter and index, branch adapter/<hash>, PR merged, only catalog/ touched", async () => {
  const dir = tmpCatalog();
  const port = fakePort();
  const r = await publish({ port, hash: HASH, adapterFile: adapter(), catalogDir: dir });
  assert.equal(r.ok, true);
  assert.equal(r.branch, `adapter/${HASH}`);
  assert.deepEqual(port.commits[0].files.map((f) => f.path), [`catalog/adapters/${HASH}.json`, "catalog/index.json"]);
  assert.ok(port.commits[0].files.every((f) => f.path.startsWith("catalog/")));
  assert.equal(readIndex(dir).entries[HASH].status, "ok");
  assert.deepEqual(port.merged, [1]);
});

test("fail: a placeholder with version, gate text, issue and commit goes through the same route", async () => {
  const dir = tmpCatalog();
  const port = fakePort();
  const r = await publish({ port, hash: HASH, catalogDir: dir, placeholder: { server: "production", version: "1.34.5", gate: "selfcheck failed\u0007 " + "x".repeat(500), issue: 42, commit: "b".repeat(40) } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, ["catalog/index.json"]);
  const e = readIndex(dir).entries[HASH];
  assert.equal(e.status, "needs-attention");
  assert.equal(e.version, "v1.34.5");
  assert.equal(e.issue, 42);
  assert.equal(e.commit, "b".repeat(40));
  assert.ok(e.gate.length <= 201 && !/[\x00-\x1f]/.test(e.gate));
  assert.equal(e.file, undefined);
});

test("placeholder takes the main commit from the port when none is given", async () => {
  const dir = tmpCatalog();
  await publish({ port: fakePort(), hash: HASH, catalogDir: dir, placeholder: { server: "staging", version: "master@118dd84c", gate: "x" } });
  assert.equal(readIndex(dir).entries[HASH].commit, "a".repeat(40));
});

test("a later pass replaces the placeholder with an ok entry", async () => {
  const dir = tmpCatalog();
  await publish({ port: fakePort(), hash: HASH, catalogDir: dir, placeholder: { server: "production", version: "1.34.5", gate: "x", issue: 7 } });
  assert.equal(readIndex(dir).entries[HASH].status, "needs-attention");
  const r = await publish({ port: fakePort(), hash: HASH, adapterFile: adapter(), catalogDir: dir });
  assert.equal(r.ok, true);
  const e = readIndex(dir).entries[HASH];
  assert.equal(e.status, "ok");
  assert.equal(e.commit, undefined);
  assert.equal(e.issue, null);
});

test("invalid hash is refused before any branch or path is built", async () => {
  for (const hash of ["../x", "ABCDEF01", "abc", "abcdef01/../../x", undefined]) {
    const port = fakePort();
    const r = await publish({ port, hash, adapterFile: adapter(), catalogDir: tmpCatalog() });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "validate");
    assert.deepEqual(port.calls, []);
  }
});

test("invalid adapter file or mismatched hash is refused and nothing is written", async () => {
  const dir = tmpCatalog();
  const port = fakePort();
  const r = await publish({ port, hash: HASH, adapterFile: { ...adapter(), apiVersionHash: "11111111" }, catalogDir: dir });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(dir, "adapters", `${HASH}.json`)), false);
  assert.deepEqual(port.calls, []);
  assert.equal((await publish({ port, hash: HASH, adapterFile: "{nope", catalogDir: dir })).ok, false);
});

test("assertCatalogPaths refuses anything outside catalog/", () => {
  for (const p of ["src/x.mjs", "catalog/../src/x", "/catalog/a", "catalogs/a", "catalog/a/../../b", "catalog//a", "../catalog/a", "", ".github/workflows/x.yml"]) {
    assert.throws(() => assertCatalogPaths([p]), /only files under catalog/, p);
  }
  assert.doesNotThrow(() => assertCatalogPaths(["catalog/index.json", "catalog/adapters/abcdef01.json"]));
});

test("merge failure is reported, not thrown; main is untouched and a re-run reuses the branch and PR", async () => {
  const dir = tmpCatalog();
  const port = fakePort({ mergeFails: 1 });
  const first = await publish({ port, hash: HASH, adapterFile: adapter(), catalogDir: dir });
  assert.equal(first.ok, false);
  assert.equal(first.stage, "merge");
  assert.match(first.error, /not mergeable/);
  assert.equal(first.pr, 1);
  assert.deepEqual(port.merged, []);
  const second = await publish({ port, hash: HASH, adapterFile: adapter(), catalogDir: dir });
  assert.equal(second.ok, true);
  assert.equal(port.prs.length, 1);
  assert.deepEqual(port.merged, [1]);
  assert.equal(port.commits.length, 2);
});

test("a port that throws at any step is reported as a failed result", async () => {
  const r = await publish({ port: fakePort({ failAt: "createBranch" }), hash: HASH, adapterFile: adapter(), catalogDir: tmpCatalog() });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "branch");
});

test("a placeholder will not overwrite an adapter that already exists", async () => {
  const dir = tmpCatalog();
  const r = await publish({ port: fakePort(), hash: "23c8eb8c", catalogDir: dir, placeholder: { server: "production", version: "1.34.0", gate: "x" } });
  assert.equal(r.ok, false);
  assert.equal(readIndex(dir).entries["23c8eb8c"].status, "ok");
});

test("rebuildIndex keeps placeholder fields (commit, version, gate, issue)", async () => {
  const dir = tmpCatalog();
  await publish({ port: fakePort(), hash: HASH, catalogDir: dir, placeholder: { server: "production", version: "1.34.5", gate: "g", issue: 3, commit: "c".repeat(40) } });
  const again = rebuildIndex(dir).entries[HASH];
  assert.deepEqual(again, { status: "needs-attention", server: "production", version: "v1.34.5", gate: "g", issue: 3, commit: "c".repeat(40) });
});

test("fetchIndex keeps commit/version/gate/issue on a placeholder and still strips file/sha256", async () => {
  const entry = { status: "needs-attention", server: "production", version: "v1.34.5", gate: "g", issue: 3, commit: "c".repeat(40), file: "adapters/x.json", sha256: "d".repeat(64) };
  const body = JSON.stringify({ schema: 1, entries: { [HASH]: entry } });
  const r = await fetchIndex({ url: "https://example.test/index.json", fetch: async () => new Response(body) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.index.entries[HASH], { status: "needs-attention", server: "production", version: "v1.34.5", gate: "g", issue: 3, commit: "c".repeat(40) });
});

test("REST adapter: calls GitHub through the injected fetch and never leaks the token", async () => {
  const TOKEN = "ghp_SECRETTOKEN123";
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body && JSON.parse(init.body) });
    const u = new URL(url).pathname;
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (u.endsWith("/git/ref/heads/main")) return json({ object: { sha: "m1" } });
    if (u.endsWith("/git/refs")) return json({ message: "Reference already exists" }, 422);
    if (init.method === "PATCH" && u.endsWith("/git/refs/heads/adapter/abcdef01")) return json({});
    if (u.endsWith("/git/ref/heads/adapter/abcdef01")) return json({ object: { sha: "h1" } });
    if (u.endsWith("/git/commits/h1")) return json({ tree: { sha: "t0" } });
    if (u.endsWith("/git/trees")) return json({ sha: "t1" });
    if (u.endsWith("/git/commits")) return json({ sha: "c1" });
    if (url.includes("/pulls?")) return json([{ number: 9 }]);
    if (u.endsWith("/pulls/9/merge")) return json({ message: `nope ${TOKEN}` }, 405);
    return json({ message: "unexpected" }, 500);
  };
  const port = createGithubPort({ repo: "campey/workadventurer", token: TOKEN, fetch });
  assert.equal(await port.mainCommit(), "m1");
  await port.createBranch("adapter/abcdef01", "m1");
  assert.ok(calls.some((c) => c.method === "PATCH" && c.body.force === true));
  await port.commit({ branch: "adapter/abcdef01", message: "m", files: [{ path: "catalog/index.json", content: "{}" }] });
  assert.deepEqual(calls.find((c) => c.url.endsWith("/git/trees")).body.tree[0].path, "catalog/index.json");
  assert.deepEqual(await port.findOpenPr("adapter/abcdef01"), { number: 9 });
  await assert.rejects(port.commit({ branch: "adapter/abcdef01", message: "m", files: [{ path: "src/a.mjs", content: "" }] }), /catalog/);
  await assert.rejects(port.merge(9), (e) => { assert.ok(!e.message.includes(TOKEN)); assert.match(e.message, /405/); return true; });
  assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
});
