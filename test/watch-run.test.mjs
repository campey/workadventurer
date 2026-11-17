import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWatch, parseOnly, parseArgs, gateSummary, dryRunPort, main, createSyncCheckout, scrubEnv } from "../scripts/watch/run.mjs";
import { fingerprintOf } from "../scripts/watch/github-port.mjs";
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
  // main moves with every merge and its `catalog` tree entry changes (as the real repo's does)
  g.main = MAIN;
  g.tree = [{ path: "src", sha: "s1" }, { path: "scripts", sha: "t1" }, { path: "catalog", sha: "c0" }];
  g.mainCommit = async () => g.main;
  g.codeFingerprint = async () => fingerprintOf(g.tree);
  g.createBranch = async (name, sha) => { g.writes.push("createBranch"); g.branches.set(name, sha); };
  g.commit = async ({ branch }) => { g.writes.push("commit"); const sha = String(++n).padStart(40, "c"); g.branches.set(branch, sha); return { sha }; };
  g.findOpenPr = async () => null;
  g.openPr = async ({ branch, title }) => { g.writes.push("openPr"); g.prs.push({ number: g.prs.length + 1, branch, title }); return { number: g.prs.length }; };
  g.merge = async (num) => { g.writes.push("merge"); g.main = String(++n).padStart(40, "d"); g.tree.find((e) => e.path === "catalog").sha = `c${n}`; return { merged: true }; };
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
    codeFingerprint: () => github.codeFingerprint(),
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
    publish: async (a) => publish({ checkoutCommit: await github.mainCommit(), sleep: async () => {}, ...a }),
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
  assert.equal(e.commit, await s.github.codeFingerprint());
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

test("retest triggers: force, code changed, version changed", async () => {
  const s = setup({ pages: { staging: pages().staging }, gateResults: { staging: "selfcheck" } });
  await run(s, { targets: ["staging"] });
  s.gateCalls.length = 0;
  assert.equal((await run(s, { targets: ["staging"] })).results[0].outcome, "skip");
  assert.equal((await run(s, { targets: ["staging"], force: true })).results[0].outcome, "fail");
  assert.equal(s.gateCalls.length, 1);
  s.github.tree.find((e) => e.path === "src").sha = "s2"; // code changed
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

test("workflow: parses, triggers, concurrency, two-job split", { skip: !YAML && "yaml not installed" }, () => {
  const wf = YAML.parse(wfText);
  const on = wf.on ?? wf[true];
  assert.ok(on.schedule[0].cron.split(" ")[0] !== "0", "cron minute is off the hour");
  assert.deepEqual(Object.keys(on.workflow_dispatch.inputs).sort(), ["dry_run", "force", "hash", "version"]);
  assert.deepEqual(on.repository_dispatch.types, ["wa-release"]);
  assert.equal(wf.concurrency.group, "adapter-watch");
  assert.equal(wf.concurrency["cancel-in-progress"], false);
  assert.deepEqual(wf.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(wf.jobs).sort(), ["gate", "publish"]);
  const { gate, publish } = wf.jobs;

  // gate: third-party code, read-only, no token or secret anywhere in it
  assert.deepEqual(gate.permissions, { contents: "read" });
  const gateText = JSON.stringify(gate);
  assert.ok(!/secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN/.test(gateText), "no token or secret in the gate job");
  assert.ok(gate.steps.some((st) => String(st.uses).startsWith("actions/setup-java")));
  assert.ok(gate.steps.some((st) => /--phase gate/.test(st.run ?? "")));
  assert.ok(gate.steps.some((st) => String(st.uses).startsWith("actions/upload-artifact")));
  assert.equal(gate.steps.find((st) => String(st.uses).startsWith("actions/checkout")).with["persist-credentials"], false);
  assert.ok(gate.steps.some((st) => st.run === "npm ci --ignore-scripts"));
  assert.match(gate.if, /refs\/heads\/main/);
  // third-party code must not save a cache a write job could restore
  const gradle = gate.steps.find((st) => String(st.uses).startsWith("gradle/actions/setup-gradle"));
  assert.equal(gradle.with["cache-disabled"], true);
  const node = gate.steps.find((st) => String(st.uses).startsWith("actions/setup-node"));
  assert.ok(!node.with.cache, "no npm cache in the gate job");

  // publish: the only writer, runs no gate code
  assert.deepEqual(publish.permissions, { contents: "write", "pull-requests": "write", issues: "write" });
  assert.equal(publish.needs, "gate");
  assert.match(publish.if, /!cancelled\(\)/);
  assert.ok(!/always\(\)/.test(publish.if));
  assert.match(publish.if, /needs\.gate\.result != 'cancelled'/);
  assert.match(publish.if, /refs\/heads\/main/);
  assert.ok(publish.steps.some((st) => String(st.uses).startsWith("actions/download-artifact")));
  assert.ok(!publish.steps.some((st) => /setup-java|setup-gradle/.test(String(st.uses))), "no Java or Gradle in publish");
  assert.ok(!/gradle|selfcheck|scenarios|--phase (gate|all)/i.test(publish.steps.map((st) => st.run ?? "").join("\n")), "no gate code in publish");
  assert.ok(publish.steps.some((st) => st.run === "npm ci --ignore-scripts"));
  assert.ok(publish.steps.some((st) => /--phase publish/.test(st.run ?? "")));
  assert.equal(publish.steps.find((st) => String(st.uses).startsWith("actions/checkout")).with["persist-credentials"], false);
  assert.ok(publish["timeout-minutes"] <= 120);
  for (const job of [gate, publish]) for (const st of job.steps) if (st.run) assert.ok(!/\$\{\{/.test(st.run), `no expression in run: ${st.run}`);
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

test("R11: the watcher's own catalog merge does not retrigger; a non-catalog change does", async () => {
  const s = setup({ pages: pages(), gateResults: { production: "selfcheck", staging: "selfcheck" } });
  const first = await run(s);
  assert.deepEqual(first.results.map((x) => x.outcome), ["fail", "fail"]);
  assert.notEqual(s.github.main, MAIN, "merges advanced main");
  s.gateCalls.length = 0;
  const again = await run(s);
  assert.deepEqual(again.results.map((x) => x.outcome), ["skip", "skip"]);
  assert.equal(s.gateCalls.length, 0);
  s.github.tree.find((e) => e.path === "scripts").sha = "t2";
  const third = await run(s);
  assert.deepEqual(third.results.map((x) => x.outcome), ["fail", "fail"]);
});

test("the same failing hash on both servers is gated once per run", async () => {
  const same = { hash: PROD_HASH, release: "v1.34.9" };
  const s = setup({ pages: { production: same, staging: { hash: PROD_HASH, release: "master@abcdef0123456789" } }, gateResults: { production: "selfcheck" } });
  const r = await run(s);
  assert.deepEqual(r.results.map((x) => x.outcome), ["fail", "skip"]);
  assert.equal(s.gateCalls.length, 1);
  assert.equal(s.github.issues.length, 1);
});

test("a 40-hex staging release is normalised before it reaches issues and the placeholder", async () => {
  const s = setup({ pages: { staging: { hash: STAGE_HASH, release: "master@" + "abcdef0123".repeat(4) } }, gateResults: { staging: "selfcheck" } });
  const r = await run(s, { targets: ["staging"] });
  assert.deepEqual(r.faults, []);
  assert.equal(readIndex(s.catalogDir).entries[STAGE_HASH].version, "master@abcdef01");
});

test("--version narrows to a server showing that version", async () => {
  const s = setup({ pages: pages() });
  const r = await run(s, { only: { version: "v1.34.9" } });
  assert.deepEqual(r.results.map((x) => x.outcome), ["pass", "skip"]);
});

test("syncCheckout: token only in the fetch's env, never argv", async () => {
  const calls = [];
  await createSyncCheckout({ token: "sekret-token", cwd: "/x", exec: (args, o) => calls.push({ args, env: o.env }) })();
  assert.deepEqual(calls.map((c) => c.args[0]), ["checkout", "clean", "fetch", "merge"]);
  assert.ok(!JSON.stringify(calls.map((c) => c.args)).includes("sekret-token"));
  assert.ok(!JSON.stringify(calls.map((c) => c.args)).includes(Buffer.from("x-access-token:sekret-token").toString("base64")));
  assert.equal(calls.filter((c) => c.env).length, 1);
  assert.equal(calls[2].env.GIT_CONFIG_COUNT, "1");
  assert.ok(calls[2].env.GIT_CONFIG_VALUE_0.includes(Buffer.from("x-access-token:sekret-token").toString("base64")));
  assert.deepEqual(calls[3].args, ["merge", "--ff-only", "FETCH_HEAD"]);
});

test("main(): config errors, publish only from main, token scrubbed, exit codes", async () => {
  const base = { GITHUB_TOKEN: "tok", GITHUB_REPOSITORY: "campey/workadventurer", GITHUB_REF: "refs/heads/main" };
  const quiet = console.log; console.log = () => {};
  try {
    await assert.rejects(() => main([], { ...base, GITHUB_TOKEN: "" }), /GITHUB_TOKEN/);
    await assert.rejects(() => main([], { ...base, GITHUB_REPOSITORY: "" }), /GITHUB_REPOSITORY/);
    await assert.rejects(() => main([], { ...base, GITHUB_REF: "refs/heads/feature" }, { deps: {} }), /only refs\/heads\/main/);
    await assert.rejects(() => main([], { ...base, ADAPTER_WATCH_HASH: "bad;hash" }), /hash/);

    // a dry run from a branch is allowed; the token is scrubbed from the process environment first
    const s = setup({ pages: pages() });
    const procEnv = { GITHUB_TOKEN: "tok", GH_TOKEN: "tok", PATH: "/bin" };
    assert.equal(await main(["--dry-run"], { ...base, GITHUB_REF: "refs/heads/feature" }, { deps: s.deps, procEnv, catalogDir: s.catalogDir }), 0);
    assert.deepEqual(procEnv, { PATH: "/bin" });
    assert.deepEqual(s.github.writes, []);

    // exit 1 on a watcher fault (unreadable server), 0 on a failed gate
    const f = setup({ pages: { staging: pages().staging } });
    assert.equal(await main([], base, { deps: f.deps, procEnv: {}, catalogDir: f.catalogDir }), 1);
    const g = setup({ pages: pages(), gateResults: { production: "selfcheck", staging: "selfcheck" } });
    assert.equal(await main([], base, { deps: g.deps, procEnv: {}, catalogDir: g.catalogDir }), 0);
  } finally { console.log = quiet; }
  const e = { GITHUB_TOKEN: "a", GH_TOKEN: "b", X: "1" }; scrubEnv(e); assert.deepEqual(e, { X: "1" });
});

// ---- the two phases ----
import { runGatePhase, runPublishPhase, validateVerdict, readVerdictFile, writeVerdicts, localCodeFingerprint, VERDICT_MAX_BYTES } from "../scripts/watch/run.mjs";
import { execFileSync } from "node:child_process";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const explode = new Proxy({}, { get: (_, k) => { throw new Error(`gate phase touched github.${String(k)}`); } });
const verdictOf = (dir, t) => JSON.parse(fs.readFileSync(path.join(dir, `${t}.json`), "utf8"));
const putVerdict = (dir, t, v) => fs.writeFileSync(path.join(dir, `${t}.json`), typeof v === "string" ? v : JSON.stringify(v));

test("phase gate: writes verdicts, nothing else; zero GitHub use", async () => {
  const s = setup({ pages: pages(), gateResults: { staging: "selfcheck" } });
  const dir = tmp("verdicts-");
  const r = await runWatch({ ...s.deps, github: explode }, { phase: "gate", verdictDir: dir, catalogDir: s.catalogDir });
  assert.deepEqual(r.faults, []);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["production.json", "staging.json"]);
  const p = verdictOf(dir, "production");
  assert.deepEqual(Object.keys(p).sort(), ["hash", "pass", "server", "steps", "version"]);
  assert.equal(p.pass, true);
  assert.equal(verdictOf(dir, "staging").pass, false);
  assert.deepEqual(s.github.writes, []);
  assert.equal(readIndex(s.catalogDir).entries[PROD_HASH], undefined); // nothing published
});

test("phase publish: publishes a pass and a fail from verdict files", async () => {
  const s = setup({ pages: pages(), gateResults: { staging: "selfcheck" } });
  const dir = tmp("verdicts-");
  await runWatch(s.deps, { phase: "gate", verdictDir: dir, catalogDir: s.catalogDir });
  s.gateCalls.length = 0;
  const r = await runWatch(s.deps, { phase: "publish", verdictDir: dir, catalogDir: s.catalogDir, runUrl: RUN_URL });
  assert.deepEqual(r.faults, []);
  assert.deepEqual(r.results.map((x) => x.outcome), ["pass", "fail"]);
  assert.equal(s.gateCalls.length, 0, "publish runs no gate");
  const idx = readIndex(s.catalogDir);
  assert.equal(idx.entries[PROD_HASH].status, "ok");
  assert.equal(idx.entries[STAGE_HASH].status, "needs-attention");
  assert.match(idx.entries[STAGE_HASH].gate, /^selfcheck/);
  assert.equal(s.github.issues.length, 1);
});

test("phase publish: no verdict means nothing to do", async () => {
  const s = setup({ pages: pages() });
  const r = await runWatch(s.deps, { phase: "publish", verdictDir: tmp("empty-"), catalogDir: s.catalogDir });
  assert.deepEqual(r.results.map((x) => x.outcome), ["skip", "skip"]);
  assert.deepEqual(s.github.writes, []);
});

async function forged(mutate, { raw } = {}) {
  const s = setup({ pages: { production: pages().production } });
  const dir = tmp("verdicts-");
  await runWatch(s.deps, { phase: "gate", verdictDir: dir, targets: ["production"], catalogDir: s.catalogDir });
  const v = verdictOf(dir, "production");
  putVerdict(dir, "production", raw ?? (mutate(v) ?? v));
  const r = await runWatch(s.deps, { phase: "publish", verdictDir: dir, targets: ["production"], catalogDir: s.catalogDir });
  return { s, r };
}

test("phase publish rejects forged verdicts and writes nothing", async () => {
  const cases = {
    "unknown step": (v) => { v.steps[1].name = "rm-rf"; },
    "extra field (adapter content)": (v) => { v.adapter = { schema: 1 }; },
    "pass claimed over a failing step": (v) => { v.steps[0].status = "fail"; },
    "pass with a missing step": (v) => { v.steps.pop(); },
    "bad status": (v) => { v.steps[0].status = "great"; },
    "bad hash": (v) => { v.hash = "../../etc"; },
    "wrong server": (v) => { v.server = "staging"; },
    "bad version": (v) => { v.version = "v1;rm"; },
    "oversized detail": (v) => { v.steps[0].detail = "x".repeat(5000); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const { s, r } = await forged(mutate);
    assert.equal(r.results[0].outcome, "fault", name);
    assert.deepEqual(s.github.writes, [], name);
  }
  const big = await forged(null, { raw: JSON.stringify({ pad: "x".repeat(VERDICT_MAX_BYTES) }) });
  assert.equal(big.r.results[0].outcome, "fault");
  assert.match(big.r.faults[0], /too large/);
  const junk = await forged(null, { raw: "not json" });
  assert.equal(junk.r.results[0].outcome, "fault");
  assert.deepEqual(junk.s.github.writes, []);
});

test("phase publish: a verdict for a hash or version the server no longer announces is skipped", async () => {
  const s = setup({ pages: pages() });
  const dir = tmp("verdicts-");
  await runWatch(s.deps, { phase: "gate", verdictDir: dir, catalogDir: s.catalogDir });
  s.deps.readServer = async (t) => (t === "production" ? { hash: "33333333", release: "v1.34.9" } : { hash: STAGE_HASH, release: "master@ffffffff00" });
  const r = await runWatch(s.deps, { phase: "publish", verdictDir: dir, catalogDir: s.catalogDir });
  assert.deepEqual(r.results.map((x) => x.outcome), ["skip", "skip"]);
  assert.equal(r.warnings.length, 2);
  assert.deepEqual(r.faults, []);
  assert.deepEqual(s.github.writes, []);
});

test("phase publish ignores adapter content in the artifact: the published file is rebuilt", async () => {
  const s = setup({ pages: { production: pages().production } });
  const dir = tmp("verdicts-");
  await runWatch(s.deps, { phase: "gate", verdictDir: dir, targets: ["production"], catalogDir: s.catalogDir });
  // an extra "adapter" file next to the verdict is never read
  fs.writeFileSync(path.join(dir, "adapter.json"), JSON.stringify({ ...baseFile, apiVersionHash: PROD_HASH, movement: { walkPxPerS: 1, runPxPerS: 2 } }));
  const r = await runWatch(s.deps, { phase: "publish", verdictDir: dir, targets: ["production"], catalogDir: s.catalogDir });
  assert.deepEqual(r.faults, []);
  const published = JSON.parse(fs.readFileSync(path.join(s.catalogDir, "adapters", `${PROD_HASH}.json`), "utf8"));
  assert.deepEqual(published.movement, baseFile.movement);
});

test("validateVerdict returns a rebuilt minimal object with sanitised detail", () => {
  const raw = { server: "staging", hash: STAGE_HASH, version: null, pass: false, steps: [{ name: "selfcheck", status: "fail", detail: "bad\u0007text" }] };
  const v = validateVerdict(raw, { target: "staging" });
  assert.equal(v.ok, true);
  assert.notEqual(v.verdict, raw);
  assert.equal(v.verdict.steps[0].detail, "bad text");
  assert.equal(validateVerdict(raw, { target: "production" }).ok, false);
  assert.equal(validateVerdict([], { target: "staging" }).ok, false);
  assert.throws(() => readVerdictFile(tmp("v-"), "../x"), /unknown target/);
  const d = tmp("v-");
  writeVerdicts(d, new Map([["staging", raw]]));
  assert.deepEqual(readVerdictFile(d, "staging").raw, raw);
  assert.equal(readVerdictFile(d, "production"), null);
});

test("localCodeFingerprint matches the API-side fingerprint of the same tree", () => {
  const repo = tmp("fp-");
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  fs.mkdirSync(path.join(repo, "catalog"));
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "catalog", "i.json"), "{}");
  fs.writeFileSync(path.join(repo, "src", "a.js"), "1");
  fs.writeFileSync(path.join(repo, "README.md"), "hi");
  git("add", "-A"); git("commit", "-qm", "x");
  const entries = git("ls-tree", "HEAD").trim().split("\n").map((l) => ({ path: l.split("\t")[1], sha: l.split(/\s/)[2] }));
  const fp = localCodeFingerprint(repo);
  assert.equal(fp, fingerprintOf(entries));
  fs.writeFileSync(path.join(repo, "catalog", "i.json"), "{\"a\":1}"); git("add", "-A"); git("commit", "-qm", "y");
  assert.equal(localCodeFingerprint(repo), fp, "a catalog-only change keeps the fingerprint");
});

test("main --phase gate needs no token or repo and makes no GitHub call", async () => {
  const s = setup({ pages: pages() });
  const dir = tmp("verdicts-");
  const quiet = console.log; console.log = () => {};
  try {
    assert.equal(await main(["--phase", "gate", "--verdict-dir", dir], { GITHUB_REF: "refs/heads/feature" }, { deps: { ...s.deps, github: explode }, procEnv: {}, catalogDir: s.catalogDir }), 0);
    await assert.rejects(() => main(["--phase", "publish"], { GITHUB_REPOSITORY: "a/b" }), /GITHUB_TOKEN/);
    await assert.rejects(() => main(["--phase", "bogus"], {}), /phase/);
  } finally { console.log = quiet; }
  assert.ok(fs.existsSync(path.join(dir, "production.json")));
});

test("publish phase takes the fingerprint once, before any sync, for every target", async () => {
  const s = setup({ pages: pages(), gateResults: { production: "selfcheck", staging: "selfcheck" } });
  const dir = tmp("verdicts-");
  await runWatch(s.deps, { phase: "gate", verdictDir: dir, catalogDir: s.catalogDir });
  let calls = 0;
  s.deps.codeFingerprint = async () => `${++calls}`.padStart(40, "e");
  s.deps.syncCheckout = async () => { s.synced.push(1); };
  const r = await runWatch(s.deps, { phase: "publish", verdictDir: dir, catalogDir: s.catalogDir });
  assert.deepEqual(r.faults, []);
  assert.equal(calls, 1);
  assert.equal(s.synced.length, 1, "a sync happened between the two targets");
  const idx = readIndex(s.catalogDir);
  assert.equal(idx.entries[PROD_HASH].commit, "1".padStart(40, "e"));
  assert.equal(idx.entries[STAGE_HASH].commit, "1".padStart(40, "e"));
});

test("publish phase honours --hash/--version narrowing", async () => {
  const s = setup({ pages: pages() });
  const dir = tmp("verdicts-");
  await runWatch(s.deps, { phase: "gate", verdictDir: dir, catalogDir: s.catalogDir });
  const r = await runWatch(s.deps, { phase: "publish", verdictDir: dir, catalogDir: s.catalogDir, only: { hash: STAGE_HASH } });
  assert.deepEqual(r.results.map((x) => x.outcome), ["skip", "pass"]);
  assert.equal(readIndex(s.catalogDir).entries[PROD_HASH], undefined);
  const r2 = await runWatch(setup({ pages: pages() }).deps, { phase: "publish", verdictDir: dir, catalogDir: tmpCatalog(), only: { version: "v9.9.9" } });
  assert.deepEqual(r2.results.map((x) => x.outcome), ["skip", "skip"]);
});

test("the verdict directory is capped before anything is read", async () => {
  const s = setup({ pages: pages() });
  const dir = tmp("verdicts-");
  await runWatch(s.deps, { phase: "gate", verdictDir: dir, catalogDir: s.catalogDir });
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `x${i}.txt`), "x");
  const r = await runWatch(s.deps, { phase: "publish", verdictDir: dir, catalogDir: s.catalogDir });
  assert.deepEqual(r.results.map((x) => x.outcome), ["fault", "fault"]);
  assert.match(r.faults[0], /more than 8/);
  assert.deepEqual(s.github.writes, []);
  const big = tmp("verdicts-");
  for (const t of ["production", "staging"]) fs.writeFileSync(path.join(big, `${t}.json`), "x".repeat(15000));
  fs.writeFileSync(path.join(big, "a.bin"), "x".repeat(40000));
  assert.match(readVerdictFile(big, "staging").error, /too large/);
});
