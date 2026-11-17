import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWatch, parseOnly, parseArgs, gateSummary, dryRunPort } from "../scripts/watch/run.mjs";
import { decide, buildCandidate } from "../scripts/watch/candidate.mjs";
import { publish } from "../scripts/watch/publish.mjs";
import { reportPass, reportFailure } from "../scripts/watch/issues.mjs";
import { runGate } from "../scripts/watch/gate.mjs";
import { rebuildIndex } from "../scripts/catalog-index.mjs";

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "catalog");
const MAIN = "a".repeat(40);
const PROD_HASH = "11111111";
const STAGE_HASH = "22222222";

function tmpCatalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-"));
  fs.mkdirSync(path.join(dir, "adapters"));
  fs.copyFileSync(path.join(SRC, "adapters", "23c8eb8c.json"), path.join(dir, "adapters", "23c8eb8c.json"));
  rebuildIndex(dir);
  return dir;
}
const readIndex = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
const baseFile = JSON.parse(fs.readFileSync(path.join(SRC, "adapters", "23c8eb8c.json"), "utf8"));

// A fake GitHub: branches, PRs, issues.
function fakeGithub() {
  const g = { repo: "campey/workadventurer", writes: [], prs: [], issues: [], branches: new Map() };
  let n = 0;
  g.mainCommit = async () => MAIN;
  g.createBranch = async (name, sha) => { g.writes.push("createBranch"); g.branches.set(name, sha); };
  g.commit = async ({ branch }) => { g.writes.push("commit"); const sha = String(++n).padStart(40, "c"); g.branches.set(branch, sha); return { sha }; };
  g.findOpenPr = async () => null;
  g.openPr = async ({ branch, title }) => { g.writes.push("openPr"); g.prs.push({ number: g.prs.length + 1, branch, title }); return { number: g.prs.length }; };
  g.merge = async (num) => { g.writes.push("merge"); return { merged: true }; };
  g.findIssues = async ({ label, state }) => ({ issues: g.issues.filter((i) => (state === "all" || i.state === state) && (!label || i.labels.includes(label))).map((i) => ({ ...i })), truncated: false });
  g.createIssue = async ({ title, body, labels }) => { g.writes.push("createIssue"); const i = { number: 100 + g.issues.length, title, body, labels, state: "open" }; g.issues.push(i); return { number: i.number, labels }; };
  g.addLabels = async (num) => ({ labels: ["adapter-watch"] });
  g.updateIssue = async (num, { title, body }) => { g.writes.push("updateIssue"); Object.assign(g.issues.find((i) => i.number === num), { title, body }); return { number: num }; };
  g.closeIssue = async (num) => { g.writes.push("closeIssue"); g.issues.find((i) => i.number === num).state = "closed"; return { closed: true }; };
  return g;
}

function setup({ pages, gateResults = {}, catalogDir = tmpCatalog(), github = fakeGithub(), vendorHash } = {}) {
  const gateCalls = [];
  const synced = [];
  const deps = {
    github,
    loadIndex: () => readIndex(catalogDir),
    readServer: async (t) => (pages[t] === undefined ? null : pages[t]),
    vendorProto: async (server, release) => ({ apiVersionHash: vendorHash?.[server] ?? pages[server].hash, protoBuf: Buffer.from("syntax = 'proto3';") }),
    buildCandidate: (a) => buildCandidate({ ...a, fetchBase: async () => ({ ok: true, file: baseFile }) }),
    runGate: async (a) => {
      gateCalls.push({ server: a.server, hash: a.file.apiVersionHash, hasProto: fs.existsSync(a.candidateProto) });
      const failAt = gateResults[a.server];
      const runners = Object.fromEntries(["proto-diff", "selfcheck", "scenarios", "kotlin-smoke"].map((s) => [s, async () => (s === failAt ? { ok: false, detail: `${s} broke` } : { ok: true })]));
      return runGate({ ...a, runners });
    },
    publish: (a) => publish({ checkoutCommit: MAIN, sleep: async () => {}, ...a }),
    reportPass,
    reportFailure,
    syncCheckout: async () => { synced.push(1); },
    runnersFor: () => ({}),
    tmpDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "run-proto-")),
  };
  return { deps, catalogDir, github, gateCalls, synced };
}
const pages = () => ({
  production: { hash: PROD_HASH, release: "v1.34.9" },
  staging: { hash: STAGE_HASH, release: "master@abcdef0123456789" },
});
const RUN_URL = "https://github.com/campey/workadventurer/actions/runs/123";
const run = (s, o = {}) => runWatch(s.deps, { catalogDir: s.catalogDir, runUrl: RUN_URL, ...o });

test("pass: both new hashes gate, publish and merge; no issue opened", async () => {
  const s = setup({ pages: pages() });
  const r = await run(s);
  assert.deepEqual(r.faults, []);
  assert.deepEqual(r.results.map((x) => x.outcome), ["pass", "pass"]);
  const idx = readIndex(s.catalogDir);
  assert.equal(idx.entries[PROD_HASH].status, "ok");
  assert.equal(idx.entries[STAGE_HASH].status, "ok");
  assert.equal(s.github.prs.length, 2);
  assert.ok(s.gateCalls.every((c) => c.hasProto));
  assert.equal(s.github.issues.length, 0);
  assert.equal(s.synced.length, 1); // refreshed between the two merges
});

test("fail: placeholder carries the failing step, main commit and issue number; exit-worthy faults stay empty", async () => {
  const s = setup({ pages: pages(), gateResults: { production: "selfcheck", staging: "kotlin-smoke" } });
  const r = await run(s);
  assert.deepEqual(r.faults, []);
  assert.deepEqual(r.results.map((x) => x.outcome), ["fail", "fail"]);
  const idx = readIndex(s.catalogDir);
  const e = idx.entries[PROD_HASH];
  assert.equal(e.status, "needs-attention");
  assert.match(e.gate, /^selfcheck: selfcheck broke/);
  assert.equal(e.commit, MAIN);
  assert.equal(e.issue, s.github.issues.find((i) => /adapter 11111111/.test(i.title)).number);
  assert.match(idx.entries[STAGE_HASH].gate, /^kotlin-smoke/);
  assert.equal(s.github.issues.length, 2);
  assert.ok(s.github.issues.every((i) => i.body.includes(RUN_URL)));
});

test("a later pass closes the open issue", async () => {
  const s = setup({ pages: { production: pages().production }, gateResults: { production: "scenarios" } });
  await run(s, { targets: ["production"], force: true });
  assert.equal(s.github.issues[0].state, "open");
  s.deps.runGate = async (a) => runGate({ ...a, runners: Object.fromEntries(["proto-diff", "selfcheck", "scenarios", "kotlin-smoke"].map((n) => [n, async () => ({ ok: true })])) });
  const r = await run(s, { targets: ["production"], force: true });
  assert.equal(r.results[0].outcome, "pass");
  assert.equal(s.github.issues[0].state, "closed");
  assert.equal(readIndex(s.catalogDir).entries[PROD_HASH].status, "ok");
});

test("skip: known ok hash and an unchanged needs-attention hash do not gate", async () => {
  const s = setup({ pages: { production: { hash: "23c8eb8c", release: "v1.34.0" }, staging: pages().staging }, gateResults: { staging: "selfcheck" } });
  await run(s);
  s.gateCalls.length = 0;
  const r = await run(s); // staging now needs-attention with the same commit and version
  assert.deepEqual(r.results.map((x) => x.outcome), ["skip", "skip"]);
  assert.equal(s.gateCalls.length, 0);
  assert.equal(r.faults.length, 0);
});

test("retest triggers: force, main moved, version changed", async () => {
  const s = setup({ pages: { staging: pages().staging }, gateResults: { staging: "selfcheck" } });
  await run(s, { targets: ["staging"] });
  s.gateCalls.length = 0;
  assert.equal((await run(s, { targets: ["staging"] })).results[0].outcome, "skip");
  assert.equal((await run(s, { targets: ["staging"], force: true })).results[0].outcome, "fail");
  assert.equal(s.gateCalls.length, 1);
  s.deps.github.mainCommit = async () => "b".repeat(40);
  s.deps.publish = (a) => publish({ checkoutCommit: "b".repeat(40), sleep: async () => {}, ...a });
  assert.equal((await run(s, { targets: ["staging"] })).results[0].outcome, "fail");
  assert.equal(s.gateCalls.length, 2);
  s.deps.readServer = async () => ({ hash: STAGE_HASH, release: "master@fedcba9876543210" });
  assert.equal((await run(s, { targets: ["staging"] })).results[0].outcome, "fail");
  assert.equal(s.gateCalls.length, 3);
});

test("one unreadable server is a fault but does not stop the other target", async () => {
  const s = setup({ pages: { staging: pages().staging } });
  const r = await run(s);
  assert.equal(r.results[0].outcome, "fault");
  assert.equal(r.results[1].outcome, "pass");
  assert.equal(r.faults.length, 1);
  assert.match(r.faults[0], /^production: could not read/);
});

test("a proto hash that disagrees with the page is a fault, not a gate verdict", async () => {
  const s = setup({ pages: pages(), vendorHash: { production: "99999999" } });
  const r = await run(s);
  assert.equal(r.results[0].outcome, "fault");
  assert.equal(r.results[1].outcome, "pass");
  assert.equal(readIndex(s.catalogDir).entries[PROD_HASH], undefined);
});

test("a publish error is a fault; an issue failure still records the placeholder", async () => {
  const s = setup({ pages: { staging: pages().staging } });
  s.deps.publish = async () => ({ ok: false, stage: "merge", error: "nope" });
  let r = await run(s, { targets: ["staging"] });
  assert.match(r.faults[0], /publish failed at merge/);

  const t = setup({ pages: { staging: pages().staging }, gateResults: { staging: "selfcheck" } });
  t.deps.reportFailure = async () => ({ ok: false, stage: "create", error: "403" });
  r = await run(t, { targets: ["staging"] });
  assert.match(r.faults[0], /reporting the failure failed/);
  assert.equal(readIndex(t.catalogDir).entries[STAGE_HASH].status, "needs-attention");
});

test("labelMissing and truncated are warnings, not faults", async () => {
  const s = setup({ pages: { staging: pages().staging }, gateResults: { staging: "selfcheck" } });
  s.deps.reportFailure = async () => ({ ok: true, action: "created", issue: 5, extras: [7], labelMissing: true, truncated: true });
  const r = await run(s, { targets: ["staging"] });
  assert.deepEqual(r.faults, []);
  assert.equal(r.warnings.length, 3);
});

test("dry run: gates for real but writes nothing (no PR, merge, issue, catalog change)", async () => {
  const s = setup({ pages: pages(), gateResults: { staging: "selfcheck" } });
  const before = fs.readFileSync(path.join(s.catalogDir, "index.json"), "utf8");
  const lines = [];
  const r = await run(s, { dryRun: true, log: (m) => lines.push(m) });
  assert.deepEqual(r.faults, []);
  assert.deepEqual(r.results.map((x) => x.outcome), ["pass", "fail"]);
  assert.deepEqual(s.github.writes, []);
  assert.equal(fs.readFileSync(path.join(s.catalogDir, "index.json"), "utf8"), before);
  assert.equal(s.gateCalls.length, 2);
  assert.ok(lines.some((l) => /dry-run\] would publish/.test(l)));
  assert.ok(lines.some((l) => /dry-run\] would createIssue/.test(l)));
});

test("--hash narrows the run to a server showing that hash", async () => {
  const s = setup({ pages: pages() });
  const r = await run(s, { only: { hash: STAGE_HASH } });
  assert.deepEqual(r.results.map((x) => x.outcome), ["skip", "pass"]);
  assert.deepEqual(s.gateCalls.map((c) => c.server), ["staging"]);
});

test("candidate that cannot be built fails the gate as step 'candidate'", async () => {
  const s = setup({ pages: { staging: { hash: STAGE_HASH, release: "weird" } } });
  const r = await run(s, { targets: ["staging"] });
  assert.equal(r.results[0].outcome, "fail");
  assert.match(readIndex(s.catalogDir).entries[STAGE_HASH].gate, /^candidate:/);
});

test("input validation and helpers", () => {
  assert.deepEqual(parseOnly({ hash: "abcdef01", version: "v1.34.5" }), { hash: "abcdef01", version: "v1.34.5" });
  assert.throws(() => parseOnly({ hash: "x; rm -rf /" }), /hash/);
  assert.throws(() => parseOnly({ version: "$(id)" }), /version/);
  assert.deepEqual(parseOnly({ hash: "", version: "" }), {});
  assert.equal(parseArgs(["--dry-run", "--force", "--target", "staging"]).target, "staging");
  assert.throws(() => parseArgs(["--target", "moon"]), /target/);
  assert.throws(() => parseArgs(["--nope"]), /unknown/);
  assert.equal(gateSummary({ steps: [{ name: "a", status: "pass" }, { name: "b", status: "fail", detail: "x" }] }), "b: x");
  assert.equal(typeof dryRunPort(fakeGithub(), () => {}).merge, "function");
});

// ---- the workflow file ----
const wfText = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".github", "workflows", "adapter-watch.yml"), "utf8");
let YAML = null;
try { YAML = (await import("yaml")).default; } catch { /* transitive dependency; fall back to text checks */ }

test("workflow: parses, triggers, permissions, concurrency", { skip: !YAML && "yaml not installed" }, () => {
  const wf = YAML.parse(wfText);
  const on = wf.on ?? wf[true];
  assert.ok(on.schedule[0].cron.split(" ")[0] !== "0", "cron minute is off the hour");
  assert.deepEqual(Object.keys(on.workflow_dispatch.inputs).sort(), ["dry_run", "force", "hash", "version"]);
  assert.deepEqual(on.repository_dispatch.types, ["wa-release"]);
  assert.deepEqual(wf.permissions, { contents: "write", "pull-requests": "write", issues: "write" });
  assert.equal(wf.concurrency.group, "adapter-watch");
  assert.equal(wf.concurrency["cancel-in-progress"], false);
  const steps = wf.jobs.watch.steps;
  assert.ok(steps.some((s) => String(s.uses).startsWith("actions/setup-java")));
  for (const s of steps) {
    if (!s.run) continue;
    assert.ok(!/\$\{\{/.test(s.run), `no expression in run: ${s.run}`);
  }
});

test("workflow: the dispatch payload is never read; no expression in any run script", () => {
  assert.ok(!/client_payload/.test(wfText.replace(/^\s*#.*$/gm, "")), "client_payload must not be used");
  const lines = wfText.split("\n");
  lines.forEach((l, i) => {
    if (/^\s*run:/.test(l)) {
      // a block scalar's following indented lines are the script
      const indent = l.match(/^\s*/)[0].length;
      let script = l.replace(/^\s*run:\s*/, "");
      for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || lines[j].match(/^\s*/)[0].length > indent); j++) script += lines[j];
      assert.ok(!/\$\{\{/.test(script), `expression in run: ${script}`);
    }
  });
  assert.match(wfText, /concurrency:\s*\n\s*group: adapter-watch\s*\n\s*cancel-in-progress: false/);
  assert.match(wfText, /GITHUB_TOKEN: \$\{\{ github.token \}\}/);
});
