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

const MAIN = "a".repeat(40);
function fakePort({ mergeFails = 0, failAt, main = MAIN } = {}) {
  const f = { repo: "campey/workadventurer", branches: new Map(), prs: [], commits: [], calls: [], merged: [], mergeFails };
  let n = 0;
  f.mainCommit = async () => main;
  f.createBranch = async (name, sha) => { f.calls.push("createBranch"); if (failAt === "createBranch") throw new Error("boom"); f.branches.set(name, sha); };
  f.commit = async ({ branch, message, files, parent }) => {
    f.calls.push("commit"); assertCatalogPaths(files.map((x) => x.path));
    assert.equal(parent, main);
    const sha = String(++n).padStart(40, "c");
    f.branches.set(branch, sha); f.commits.push({ branch, message, files, parent, sha });
    return { sha };
  };
  f.findOpenPr = async (branch) => { const p = f.prs.find((x) => x.branch === branch && !x.merged); return p ? { number: p.number, headSha: p.foreignSha ?? f.branches.get(branch), headRepo: p.headRepo ?? f.repo } : null; };
  f.openPr = async ({ branch, title }) => { const p = { number: f.prs.length + 1, branch, title }; f.prs.push(p); return { number: p.number }; };
  f.merge = async (num, { expectedHeadSha } = {}) => {
    if (f.beforeMerge) f.beforeMerge();
    const p = f.prs.find((x) => x.number === num);
    if (expectedHeadSha !== (p.foreignSha ?? f.branches.get(p.branch))) throw new Error("409 head branch was modified");
    if (f.mergeFails > 0) { f.mergeFails--; throw new Error("405 not mergeable"); }
    p.merged = true; f.merged.push(num); return { merged: true };
  };
  return f;
}
const pub = (o) => publish({ checkoutCommit: MAIN, sleep: async () => {}, ...o });

test("pass: writes the adapter and index, branch adapter/<hash>, PR merged, only catalog/ touched", async () => {
  const dir = tmpCatalog();
  const port = fakePort();
  const r = await pub({ port, hash: HASH, adapterFile: adapter(), catalogDir: dir });
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
  const r = await pub({ port, hash: HASH, catalogDir: dir, placeholder: { server: "production", version: "1.34.5", gate: "selfcheck failed\u0007 " + "x".repeat(500), issue: 42, commit: "b".repeat(40) } });
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
  await pub({ port: fakePort(), hash: HASH, catalogDir: dir, placeholder: { server: "staging", version: "master@118dd84c", gate: "x" } });
  assert.equal(readIndex(dir).entries[HASH].commit, "a".repeat(40));
});

test("a later pass replaces the placeholder with an ok entry", async () => {
  const dir = tmpCatalog();
  await pub({ port: fakePort(), hash: HASH, catalogDir: dir, placeholder: { server: "production", version: "1.34.5", gate: "x", issue: 7 } });
  assert.equal(readIndex(dir).entries[HASH].status, "needs-attention");
  const r = await pub({ port: fakePort(), hash: HASH, adapterFile: adapter(), catalogDir: dir });
  assert.equal(r.ok, true);
  const e = readIndex(dir).entries[HASH];
  assert.equal(e.status, "ok");
  assert.equal(e.commit, undefined);
  assert.equal(e.issue, null);
});

test("invalid hash is refused before any branch or path is built", async () => {
  for (const hash of ["../x", "ABCDEF01", "abc", "abcdef01/../../x", undefined]) {
    const port = fakePort();
    const r = await pub({ port, hash, adapterFile: adapter(), catalogDir: tmpCatalog() });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "validate");
    assert.deepEqual(port.calls, []);
  }
});

test("invalid adapter file or mismatched hash is refused and nothing is written", async () => {
  const dir = tmpCatalog();
  const port = fakePort();
  const r = await pub({ port, hash: HASH, adapterFile: { ...adapter(), apiVersionHash: "11111111" }, catalogDir: dir });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(dir, "adapters", `${HASH}.json`)), false);
  assert.deepEqual(port.calls, []);
  assert.equal((await pub({ port, hash: HASH, adapterFile: "{nope", catalogDir: dir })).ok, false);
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
  const first = await pub({ port, hash: HASH, adapterFile: adapter(), catalogDir: dir });
  assert.equal(first.ok, false);
  assert.equal(first.stage, "merge");
  assert.match(first.error, /not mergeable/);
  assert.equal(first.pr, 1);
  assert.deepEqual(port.merged, []);
  const second = await pub({ port, hash: HASH, adapterFile: adapter(), catalogDir: dir });
  assert.equal(second.ok, true);
  assert.equal(port.prs.length, 1);
  assert.deepEqual(port.merged, [1]);
  assert.equal(port.commits.length, 2);
});

test("a port that throws at any step is reported as a failed result", async () => {
  const r = await pub({ port: fakePort({ failAt: "createBranch" }), hash: HASH, adapterFile: adapter(), catalogDir: tmpCatalog() });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "branch");
});

test("a placeholder will not overwrite an adapter that already exists", async () => {
  const dir = tmpCatalog();
  const r = await pub({ port: fakePort(), hash: "23c8eb8c", catalogDir: dir, placeholder: { server: "production", version: "1.34.0", gate: "x" } });
  assert.equal(r.ok, false);
  assert.equal(readIndex(dir).entries["23c8eb8c"].status, "ok");
});

test("rebuildIndex keeps placeholder fields (commit, version, gate, issue)", async () => {
  const dir = tmpCatalog();
  await pub({ port: fakePort(), hash: HASH, catalogDir: dir, placeholder: { server: "production", version: "1.34.5", gate: "g", issue: 3, commit: "c".repeat(40) } });
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
    if (u.endsWith(`/git/commits/${"a".repeat(40)}`)) return json({ tree: { sha: "t0" } });
    if (u.endsWith("/git/trees")) return json({ sha: "t1" });
    if (u.endsWith("/git/commits")) return json({ sha: "c1" });
    if (url.includes("/pulls?")) return json([{ number: 9, head: { sha: "h", repo: { full_name: "campey/workadventurer" } } }]);
    if (u.endsWith("/pulls/9/merge")) return json({ message: `nope ${TOKEN}` }, 405);
    return json({ message: "unexpected" }, 500);
  };
  const port = createGithubPort({ repo: "campey/workadventurer", token: TOKEN, fetch });
  assert.equal(await port.mainCommit(), "m1");
  await port.createBranch("adapter/abcdef01", "m1");
  assert.ok(calls.some((c) => c.method === "PATCH" && c.body.force === true));
  await port.commit({ branch: "adapter/abcdef01", message: "m", files: [{ path: "catalog/index.json", content: "{}" }], parent: "a".repeat(40) });
  assert.deepEqual(calls.find((c) => c.url.endsWith("/git/trees")).body.tree[0].path, "catalog/index.json");
  assert.deepEqual(await port.findOpenPr("adapter/abcdef01"), { number: 9, headSha: "h", headRepo: "campey/workadventurer" });
  await assert.rejects(port.commit({ branch: "adapter/abcdef01", message: "m", files: [{ path: "src/a.mjs", content: "" }], parent: "a".repeat(40) }), /catalog/);
  await assert.rejects(port.merge(9, { expectedHeadSha: "c".repeat(40) }), (e) => { assert.ok(!e.message.includes(TOKEN)); assert.match(e.message, /405/); return true; });
  assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
});

test("an existing different adapter file is never replaced; identical bytes is already-published", async () => {
  const dir = tmpCatalog();
  const first = await pub({ port: fakePort(), hash: HASH, adapterFile: adapter(), catalogDir: dir });
  assert.equal(first.ok, true);
  const before = fs.readFileSync(path.join(dir, "adapters", `${HASH}.json`), "utf8");
  const port = fakePort();
  const same = await pub({ port, hash: HASH, adapterFile: before, catalogDir: dir });
  assert.equal(same.ok, true);
  assert.equal(same.status, "already-published");
  assert.deepEqual(port.calls, []);
  const changed = adapter(); changed.movement = { ...changed.movement, walkPxPerS: 123 };
  const diff = await pub({ port, hash: HASH, adapterFile: changed, catalogDir: dir });
  assert.equal(diff.ok, false);
  assert.equal(diff.stage, "validate");
  assert.match(diff.error, /different adapter file/);
  assert.equal(fs.readFileSync(path.join(dir, "adapters", `${HASH}.json`), "utf8"), before);
  assert.deepEqual(port.calls, []);
});

test("merge is pinned: commit parent is main, merge gets our commit sha, a moved head fails at merge", async () => {
  const port = fakePort();
  const r = await pub({ port, hash: HASH, adapterFile: adapter(), catalogDir: tmpCatalog() });
  assert.equal(r.ok, true);
  assert.equal(port.commits[0].parent, MAIN);

  const moved = fakePort();
  moved.beforeMerge = () => moved.branches.set(`adapter/${HASH}`, "f".repeat(40));
  const m = await pub({ port: moved, hash: HASH, adapterFile: adapter(), catalogDir: tmpCatalog() });
  assert.equal(m.ok, false);
  assert.equal(m.stage, "merge");
  assert.match(m.error, /409/);
  assert.deepEqual(moved.merged, []);
});

test("a foreign open PR on the branch name is not merged", async () => {
  for (const extra of [{ foreignSha: "9".repeat(40) }, { headRepo: "evil/fork" }]) {
    const port = fakePort();
    port.prs.push({ number: 5, branch: `adapter/${HASH}`, ...extra });
    const r = await pub({ port, hash: HASH, adapterFile: adapter(), catalogDir: tmpCatalog() });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "merge");
    assert.deepEqual(port.merged, []);
  }
});

test("a stale checkout (main moved) fails at stage stale and touches nothing", async () => {
  const dir = tmpCatalog();
  const port = fakePort({ main: "b".repeat(40) });
  const r = await pub({ port, hash: HASH, adapterFile: adapter(), catalogDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "stale");
  assert.deepEqual(port.calls, []);
  assert.equal(fs.existsSync(path.join(dir, "adapters", `${HASH}.json`)), false);
  const unknown = await publish({ port: fakePort(), hash: HASH, adapterFile: adapter(), catalogDir: dir });
  assert.equal(unknown.stage, "stale");
});

test("placeholder version is sanitised or refused", async () => {
  const r = await pub({ port: fakePort(), hash: HASH, catalogDir: tmpCatalog(), placeholder: { server: "production", version: "1.34.5 <script>", gate: "x" } });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "validate");
  const long = await pub({ port: fakePort(), hash: HASH, catalogDir: tmpCatalog(), placeholder: { server: "production", version: "v" + "1".repeat(60), gate: "x" } });
  assert.equal(long.ok, false);
});

function restFetch(handlers, calls = []) {
  return async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    const u = new URL(url).pathname;
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    return handlers({ u, url, init, json });
  };
}

test("REST adapter: merge 405/409 reject (publish reports them), sends the pinned sha", async () => {
  const TOKEN = "ghp_SECRETTOKEN123";
  const calls = [];
  for (const status of [405, 409]) {
    const port = createGithubPort({ repo: "campey/workadventurer", token: TOKEN, fetch: restFetch(({ json }) => json({ message: "Head branch was modified" }, status), calls) });
    await assert.rejects(port.merge(9, { expectedHeadSha: "c".repeat(40) }), new RegExp(String(status)));
    assert.equal(calls.at(-1).body.sha, "c".repeat(40));
    await assert.rejects(port.merge(9), /expectedHeadSha/);
  }
});

test("REST adapter: commit parents the pinned sha and force-updates the branch", async () => {
  const calls = [];
  const P = "d".repeat(40);
  const fetch = restFetch(({ u, init, json }) => {
    if (u.endsWith(`/git/commits/${P}`)) return json({ tree: { sha: "t0" } });
    if (u.endsWith("/git/trees")) return json({ sha: "t1" });
    if (u.endsWith("/git/commits")) return json({ sha: "e".repeat(40) });
    if (init.method === "PATCH") return json({});
    return json({ message: "unexpected" }, 500);
  }, calls);
  const port = createGithubPort({ repo: "campey/workadventurer", token: "tok", fetch });
  const r = await port.commit({ branch: `adapter/${HASH}`, message: "m", files: [{ path: "catalog/index.json", content: "{}" }], parent: P });
  assert.equal(r.sha, "e".repeat(40));
  assert.deepEqual(calls.find((c) => c.url.endsWith("/git/commits")).body.parents, [P]);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch.body, { sha: "e".repeat(40), force: true });
});

test("REST adapter: createBranch resets only on 'Reference already exists'; other 422 errors", async () => {
  const mk = (message, calls) => createGithubPort({ repo: "campey/workadventurer", token: "tok", fetch: restFetch(({ init, json }) => (init.method === "POST" ? json({ message }, 422) : json({})), calls) });
  const calls = [];
  await mk("Reference already exists", calls).createBranch(`adapter/${HASH}`, MAIN);
  assert.ok(calls.some((c) => c.method === "PATCH" && c.body.force));
  const calls2 = [];
  await assert.rejects(mk("Object does not exist", calls2).createBranch(`adapter/${HASH}`, MAIN), /422/);
  assert.ok(!calls2.some((c) => c.method === "PATCH"));
});

test("REST adapter: a token straddling the 300-char cut is still scrubbed", async () => {
  const TOKEN = "ghp_STRADDLE_SECRET_TOKEN";
  const msgText = "x".repeat(300 - "GET /git/ref/heads/main: HTTP 500 ".length - 10) + TOKEN;
  const port = createGithubPort({ repo: "campey/workadventurer", token: TOKEN, fetch: restFetch(({ json }) => json({ message: msgText }, 500)) });
  await assert.rejects(port.mainCommit(), (e) => { assert.ok(!e.message.includes(TOKEN)); assert.ok(!e.message.includes("ghp_STRADDLE")); return true; });
});

test("a reused PR whose head catches up after some polls is merged; one that never does is not", async () => {
  for (const [lag, ok] of [[2, true], [1e9, false]]) {
    const port = fakePort();
    port.prs.push({ number: 5, branch: `adapter/${HASH}` });
    let polls = 0;
    const find = port.findOpenPr;
    port.findOpenPr = async (b) => { const r = await find(b); if (r && polls++ < lag) r.headSha = "0".repeat(40); return r; };
    const r = await pub({ port, hash: HASH, adapterFile: adapter(), catalogDir: tmpCatalog(), pollMs: 1, maxWaitMs: 10 });
    assert.equal(r.ok, ok);
    if (ok) assert.deepEqual(port.merged, [5]);
    else { assert.equal(r.stage, "merge"); assert.deepEqual(port.merged, []); }
  }
});

test("a port without repo fails the reuse check", async () => {
  const port = fakePort();
  delete port.repo;
  port.prs.push({ number: 5, branch: `adapter/${HASH}` });
  const r = await pub({ port, hash: HASH, adapterFile: adapter(), catalogDir: tmpCatalog() });
  assert.equal(r.stage, "merge");
});

test("already-published needs an ok index entry with the matching sha256", async () => {
  const dir = tmpCatalog();
  await pub({ port: fakePort(), hash: HASH, adapterFile: adapter(), catalogDir: dir });
  const text = fs.readFileSync(path.join(dir, "adapters", `${HASH}.json`), "utf8");
  const idx = readIndex(dir);
  idx.entries[HASH] = { status: "needs-attention", server: "production", version: "v1.34.5", gate: "x", issue: null, commit: "b".repeat(40) };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx, null, 2) + "\n");
  const port = fakePort();
  const r = await pub({ port, hash: HASH, adapterFile: text, catalogDir: dir });
  assert.equal(r.ok, true);
  assert.equal(r.status, undefined);
  assert.equal(r.merged, true);
  assert.equal(readIndex(dir).entries[HASH].status, "ok");
  assert.deepEqual(port.commits[0].files.map((f) => f.path), [`catalog/adapters/${HASH}.json`, "catalog/index.json"]);
});

test("default checkout detection: clean temp git repo works, dirty tree is stale", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-git-"));
  const dir = path.join(root, "catalog");
  fs.mkdirSync(path.join(dir, "adapters"), { recursive: true });
  fs.copyFileSync(path.join(SRC, "adapters", "23c8eb8c.json"), path.join(dir, "adapters", "23c8eb8c.json"));
  rebuildIndex(dir);
  const git = (...a) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  git("init", "-q"); git("add", "."); git("commit", "-q", "-m", "x");
  const head = git("rev-parse", "HEAD").trim();
  const dirty = path.join(dir, "stray.txt");
  fs.writeFileSync(dirty, "x");
  const r1 = await publish({ port: fakePort({ main: head }), hash: HASH, adapterFile: adapter(), catalogDir: dir, sleep: async () => {} });
  assert.equal(r1.stage, "stale");
  assert.match(r1.error, /uncommitted/);
  assert.equal(fs.existsSync(path.join(dir, "adapters", `${HASH}.json`)), false);
  fs.rmSync(dirty);
  const port = fakePort({ main: head });
  port.commit = async (a) => ({ sha: "e".repeat(40) }); // parent assertion in the shared fake is MAIN
  const r2 = await publish({ port: Object.assign(port, { findOpenPr: async () => null, openPr: async () => ({ number: 1 }), merge: async () => ({ merged: true }) }), hash: HASH, adapterFile: adapter(), catalogDir: dir, sleep: async () => {} });
  assert.equal(r2.ok, true);
});
