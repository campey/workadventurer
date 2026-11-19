// Adapter watcher orchestrator (#127): for production and staging, read the server, decide,
// then gate -> publish pass + close issue, or placeholder + issue. Run by
// .github/workflows/adapter-watch.yml; runnable locally with --dry-run.
//
//   node scripts/watch/run.mjs [--phase all|gate|publish] [--verdict-dir verdicts] [--dry-run] [--force]
//                              [--hash <h>] [--version <v>] [--target production|staging]
//
// Two phases, two jobs in the workflow (the job split is the security boundary):
//   gate     reads the servers, decides, builds the candidate, runs the gate (third-party code: selfcheck, live
//            scenarios, Gradle) and writes verdicts/<server>.json. No GitHub call, no token.
//   publish  (the only phase with write access, running no gate code) validates each verdict as UNTRUSTED data,
//            re-reads the server and requires its hash and version to match, re-decides, REBUILDS the candidate
//            adapter itself (adapter content never comes from the artifact), then publishes / opens the issue.
//   all      (default) both in one process, for local runs and dry runs.
// Residual risk: a forged verdict (the gate job runs third-party code) can at worst flip pass/fail for a hash the
// server announces right now; it cannot inject adapter content, another hash, or a write of any other kind.
//
// Trust: nothing from a repository_dispatch payload reaches this program. The workflow's
// dispatch only starts a run; every value that matters is re-read here from the servers' home
// pages. The optional --hash/--version (manual runs) only NARROW the run to a server already
// showing that hash; they are validated here and never used to build a candidate.
//
// Exit code: 0 unless the watcher itself faulted (a server could not be read, the candidate's
// proto could not be fetched, publish or an issue write failed). A failed gate is a normal
// outcome and exits 0. labelMissing / truncated issue results are warnings only.
//
// Everything with side effects is injected (`deps`), so test/watch-run.test.mjs drives the
// whole thing with fakes. GITHUB_TOKEN is only handed to the GitHub port and the proto fetch;
// it is never logged.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HASH_RE } from "../../src/catalog/schema.mjs";
import { gateDetail } from "../../src/catalog/recover.mjs";
import { readServer, decide, buildCandidate, computeHashForVersion, normaliseVersion } from "./candidate.mjs";
import { runGate, defaultRunners, STEP_NAMES } from "./gate.mjs";
import { publish } from "./publish.mjs";
import { reportFailure, reportPass } from "./issues.mjs";
import { createGithubPort, fingerprintOf } from "./github-port.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TARGET_NAMES = ["production", "staging"];

// Distinctive ONE-WORD area names (substring match, case-insensitive; "Red" would also match "Shared").
export const DEFAULT_AREAS = { production: "Fire", staging: "Meeting" };
export const STAGING_FACTS = {
  room: "https://play.staging.workadventu.re/@/tcm/workadventure/wa-village",
  pusherUrl: "https://pusher.staging.workadventu.re",
  wokaId: "62b0c71f-f396-432b-a4c8-4d369d73e766",
};

const msg = (e) => String(e?.message ?? e).slice(0, 300);

/** The failing step's "name: detail" (what a placeholder and an issue record). */
export function gateSummary(gate) {
  const bad = gate.steps.find((s) => s.status === "fail");
  return bad ? `${bad.name}: ${bad.detail ?? "failed"}` : "gate did not pass";
}

/** A port that reads from GitHub but only records its writes (dry run). */
export function dryRunPort(real, say) {
  const wrote = (name, args, ret) => async (...a) => { say(`  [dry-run] would ${name} ${JSON.stringify(args(...a))}`); return ret; };
  return {
    repo: real.repo,
    mainCommit: () => real.mainCommit(),
    codeFingerprint: () => real.codeFingerprint(),
    findOpenPr: (b) => real.findOpenPr(b),
    findIssues: (q) => real.findIssues(q),
    createBranch: wrote("createBranch", (n) => ({ branch: n }), undefined),
    commit: wrote("commit", ({ branch }) => ({ branch }), { sha: "0".repeat(40) }),
    openPr: wrote("openPr", ({ title }) => ({ title }), { number: 0 }),
    merge: wrote("merge", (n) => ({ pr: n }), { merged: true }),
    createIssue: wrote("createIssue", ({ title }) => ({ title }), { number: 0, labels: ["adapter-watch"] }),
    addLabels: wrote("addLabels", (n) => ({ issue: n }), { labels: ["adapter-watch"] }),
    updateIssue: wrote("updateIssue", (n) => ({ issue: n }), { number: 0 }),
    closeIssue: wrote("closeIssue", (n) => ({ issue: n }), { closed: true }),
  };
}

/** Validate the manual-run narrowing inputs; throws a clear Error on rubbish. */
export function parseOnly({ hash, version } = {}) {
  const only = {};
  if (hash) {
    if (!HASH_RE.test(String(hash))) throw new Error("--hash must be an adapter hash (hex)");
    only.hash = String(hash);
  }
  if (version) {
    if (!/^[\w.@-]{1,40}$/.test(String(version))) throw new Error("--version has unexpected characters or is too long");
    only.version = String(version);
  }
  return only;
}

// ---------------------------------------------------------------------------
// Verdicts: the only thing that crosses from the gate phase to the publish phase.
// ---------------------------------------------------------------------------

export const VERDICT_MAX_BYTES = 16 * 1024;
const VERSION_RE = /^[\w.@-]{1,40}$/;
const STEP_SET = [...STEP_NAMES, "candidate"];
const STATUS_SET = ["pass", "fail", "skipped"];

/** The verdict for one gated target: server, hash, display version and the gate's steps. Nothing else. */
export function makeVerdict({ server, hash, version, gate }) {
  return {
    server,
    hash,
    version: version ?? null,
    pass: gate.pass === true,
    steps: gate.steps.map((st) => ({ name: st.name, status: st.status, ...(st.detail ? { detail: st.detail } : {}) })),
  };
}

/**
 * Validate a verdict that came out of an artifact. The artifact is UNTRUSTED: it was produced by a job that ran
 * third-party code (selfcheck, scenarios, Gradle). Only a rebuilt, minimal object is ever returned; `pass` is
 * recomputed from the steps and must agree with the claim.
 */
export function validateVerdict(raw, { target } = {}) {
  const bad = (reason) => ({ ok: false, reason });
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(raw)) return bad("verdict is not an object");
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "hash,pass,server,steps,version") return bad("verdict has unexpected fields");
  if (raw.server !== target) return bad(`verdict is for "${String(raw.server).slice(0, 20)}", not ${target}`);
  if (typeof raw.hash !== "string" || !HASH_RE.test(raw.hash)) return bad("verdict hash is not an adapter hash");
  if (raw.version !== null && !(typeof raw.version === "string" && VERSION_RE.test(raw.version))) return bad("verdict version has unexpected characters");
  if (typeof raw.pass !== "boolean") return bad("verdict pass is not a boolean");
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > STEP_SET.length) return bad("verdict steps are not a short list");
  const steps = [];
  const seen = new Set();
  for (const st of raw.steps) {
    if (!isObj(st) || Object.keys(st).some((k) => !["name", "status", "detail"].includes(k))) return bad("verdict step has unexpected fields");
    if (!STEP_SET.includes(st.name) || seen.has(st.name)) return bad("verdict step name is unknown or repeated");
    if (!STATUS_SET.includes(st.status)) return bad("verdict step status is unknown");
    if (st.detail !== undefined && (typeof st.detail !== "string" || st.detail.length > 2000)) return bad("verdict step detail is not short text");
    seen.add(st.name);
    const detail = st.detail === undefined ? undefined : gateDetail(st.detail);
    steps.push({ name: st.name, status: st.status, ...(detail ? { detail } : {}) });
  }
  const derivedPass = steps.length === STEP_NAMES.length
    && steps.every((st, i) => st.name === STEP_NAMES[i] && (st.status === "pass" || (st.status === "skipped" && st.name === "scenarios" && target === "staging")));
  if (derivedPass !== raw.pass) return bad("verdict pass does not agree with its steps");
  if (!derivedPass && !steps.some((st) => st.status === "fail")) return bad("a failing verdict names no failing step");
  return { ok: true, verdict: { server: target, hash: raw.hash, version: raw.version, pass: derivedPass, steps } };
}

export function writeVerdicts(dir, verdicts) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [target, v] of verdicts) fs.writeFileSync(path.join(dir, `${target}.json`), `${JSON.stringify(v, null, 2)}\n`);
}

export const VERDICT_DIR_MAX_FILES = 8;
export const VERDICT_DIR_MAX_BYTES = 64 * 1024;

/** The whole artifact directory is capped before anything in it is read: null when fine, else a reason. */
export function checkVerdictDir(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return e.code === "ENOENT" ? null : `cannot read the verdict directory: ${e.code ?? "error"}`; }
  if (names.length > VERDICT_DIR_MAX_FILES) return `the verdict directory has ${names.length} entries (more than ${VERDICT_DIR_MAX_FILES})`;
  let total = 0;
  for (const n of names) { try { total += fs.lstatSync(path.join(dir, n)).size; } catch { /* vanished */ } }
  if (total > VERDICT_DIR_MAX_BYTES) return `the verdict directory is too large (${total} bytes)`;
  return null;
}

/** Read verdicts/<target>.json: null when absent; { error } when oversized or unparseable; else { raw }. */
export function readVerdictFile(dir, target) {
  if (!TARGET_NAMES.includes(target)) throw new Error(`unknown target ${target}`);
  const tooBig = checkVerdictDir(dir);
  if (tooBig) return { error: tooBig };
  const file = path.join(dir, `${target}.json`);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e.code === "ENOENT" ? null : { error: `cannot read ${target} verdict: ${e.code ?? "error"}` }; }
  if (!st.isFile()) return { error: `${target} verdict is not a regular file` };
  if (st.size > VERDICT_MAX_BYTES) return { error: `${target} verdict is too large (${st.size} bytes)` };
  try { return { raw: JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return { error: `${target} verdict is not valid JSON` }; }
}

// ---------------------------------------------------------------------------
// Phase 1: gate. Reads servers and the catalog, runs third-party code, writes NOTHING to GitHub.
// ---------------------------------------------------------------------------

/**
 * deps: { readServer, loadIndex, codeFingerprint, buildCandidate, vendorProto, runGate, runnersFor, tmpDir }
 * Returns { results, faults, warnings, verdicts: Map(target -> verdict) }.
 */
export async function runGatePhase(deps, { force = false, only = {}, targets = TARGET_NAMES, log = () => {} } = {}) {
  const results = [];
  const faults = [];
  const warnings = [];
  const verdicts = new Map();
  const handled = new Map(); // hash -> target that already gated it in this run
  for (const target of targets) {
    const res = { target, outcome: "error" };
    results.push(res);
    const fault = (m) => { faults.push(`${target}: ${m}`); res.outcome = "fault"; res.error = m; log(`${target}: FAULT ${m}`); };
    try {
      const server = await deps.readServer(target);
      if (!server) { fault("could not read the server's home page"); continue; }
      const { hash } = server;
      const rawRelease = server.release ?? null; // lossless, for building and fetching
      const release = rawRelease ? normaliseVersion(target, rawRelease) : null; // display form (<= 40 chars)
      if (!hash || !HASH_RE.test(hash)) { fault("the home page names no api version hash"); continue; }
      res.hash = hash;
      res.version = release;
      const skip = (why) => { res.outcome = "skip"; res.reason = why; log(`${target}: ${hash} skipped, ${why}`); };
      if (only.hash && only.hash !== hash) { skip(`not the requested hash ${only.hash}`); continue; }
      if (only.version && normaliseVersion(target, only.version) !== release) { skip(`not the requested version ${only.version}`); continue; }
      if (handled.has(hash)) { skip(`hash already handled this run as ${handled.get(hash)}`); continue; }

      const catalogIndex = deps.loadIndex();
      // Code fingerprint, not main's commit: the watcher's own catalog merges must not trigger retests.
      const codeFingerprint = await deps.codeFingerprint();
      const decision = decide({ hash, version: release, server: target, catalogIndex, force, codeFingerprint });
      if (decision.action === "skip") { skip(decision.reason); continue; }
      log(`${target}: ${hash} (${release}) gate: ${decision.reason}`);
      handled.set(hash, target);

      const cand = await deps.buildCandidate({ hash, version: rawRelease, server: target, catalogIndex });
      let gate;
      if (!cand.ok) {
        gate = { pass: false, steps: [{ name: "candidate", status: "fail", detail: cand.reason }] };
      } else {
        let vendored;
        try {
          vendored = await deps.vendorProto(target, rawRelease);
        } catch (e) { fault(`could not fetch the candidate proto: ${msg(e)}`); continue; }
        if (vendored.apiVersionHash !== hash) { fault(`upstream proto for ${release} hashes to ${vendored.apiVersionHash}, not the page's ${hash} (server moved mid-run?); try again`); continue; }
        const candidateProto = path.join(deps.tmpDir(), "messages.proto");
        fs.writeFileSync(candidateProto, Buffer.from(vendored.protoBuf));
        gate = await deps.runGate({ file: cand.file, server: target, candidateProto, runners: deps.runnersFor(target), log });
      }
      res.steps = gate.steps.map((st) => `${st.name}:${st.status}`);
      res.outcome = gate.pass ? "pass" : "fail";
      if (!gate.pass) { res.gate = gateSummary(gate); log(`${target}: ${hash} gate FAILED, ${res.gate}`); }
      verdicts.set(target, makeVerdict({ server: target, hash, version: release, gate }));
    } catch (e) {
      fault(`unexpected: ${msg(e)}`);
    }
  }
  return { results, faults, warnings, verdicts };
}

// ---------------------------------------------------------------------------
// Phase 2: publish. The only phase with GitHub write access, and it runs no gate code.
// ---------------------------------------------------------------------------

/**
 * Settle each target that has a verdict. Everything the verdict claims is re-checked: the server is re-read and
 * must still announce the verdict's hash and version, the decision is re-made, and the candidate adapter is
 * REBUILT here (adapter content never comes from the verdict). A forged verdict can at worst flip pass/fail for a
 * hash the server really announces right now.
 *   deps: { github, readServer, loadIndex, loadVerdict(target) -> null | { raw } | { error }, buildCandidate,
 *           publish, reportPass, reportFailure, syncCheckout }
 */
export async function runPublishPhase(deps, { dryRun = false, force = false, only = {}, syncFirst = true, targets = TARGET_NAMES, runUrl, catalogDir, log = () => {} } = {}) {
  const results = [];
  const faults = [];
  const warnings = [];
  const github = dryRun ? dryRunPort(deps.github, log) : deps.github;
  // The checkout may already be behind main (it moved while the gate ran): sync before the first publish. Also set
  // after every merge. Dry runs and the single-process `all` mode (just checked out) skip the first sync.
  let dirty = syncFirst && !dryRun;
  // The code fingerprint is taken ONCE, before any sync or merge, from the commit the gate also ran on, and used for
  // every target: later merges (and syncs) must not change what a placeholder records.
  let fingerprint;
  const fingerprintOnce = async () => (fingerprint ??= await deps.codeFingerprint());

  for (const target of targets) {
    const res = { target, outcome: "error" };
    results.push(res);
    const fault = (m) => { faults.push(`${target}: ${m}`); res.outcome = "fault"; res.error = m; log(`${target}: FAULT ${m}`); };
    try {
      const loaded = deps.loadVerdict(target);
      if (!loaded) {
        res.outcome = "skip"; res.reason = "no verdict from the gate"; log(`${target}: no verdict, nothing to publish`);
        // A merge whose issue close failed would leave its issue open for good (the gate skips an ok hash): close it now.
        const server = await deps.readServer(target);
        if (server?.hash && deps.loadIndex().entries?.[server.hash]?.status === "ok") {
          const rep = await deps.reportPass({ port: github, server: target, hash: server.hash, version: server.release ? normaliseVersion(target, server.release) : null, runUrl });
          if (!rep.ok) warnings.push(`${target}: could not check for a stale issue (${rep.stage}: ${rep.error})`);
          else if (rep.closed?.length) log(`${target}: closed stale issue(s) ${rep.closed.map((n) => `#${n}`).join(", ")} for the already published ${server.hash}`);
        }
        continue;
      }
      if (loaded.error) { fault(`ignoring the verdict: ${loaded.error}`); continue; }
      const checked = validateVerdict(loaded.raw, { target });
      if (!checked.ok) { fault(`ignoring the verdict: ${checked.reason}`); continue; }
      const verdict = checked.verdict;
      const { hash } = verdict;
      res.hash = hash;
      res.version = verdict.version;
      if ((only.hash && only.hash !== hash) || (only.version && normaliseVersion(target, only.version) !== verdict.version)) {
        res.outcome = "skip"; res.reason = "not the requested hash/version"; log(`${target}: ${hash} skipped, ${res.reason}`); continue;
      }

      const fp = await fingerprintOnce();
      const server = await deps.readServer(target);
      if (!server) { fault("could not read the server's home page"); continue; }
      const rawRelease = server.release ?? null;
      const release = rawRelease ? normaliseVersion(target, rawRelease) : null;
      if (server.hash !== hash || release !== verdict.version) {
        res.outcome = "skip"; res.reason = "the server no longer announces the verdict's hash and version";
        warnings.push(`${target}: ${res.reason} (verdict ${hash} ${verdict.version}, now ${server.hash} ${release}); a later run will decide`);
        continue;
      }
      if (dirty) {
        try { await deps.syncCheckout(); dirty = false; } catch (e) { fault(`could not refresh the checkout after a merge: ${msg(e)}`); continue; }
      }
      const catalogIndex = deps.loadIndex();
      const codeFingerprint = fp;
      const decision = decide({ hash, version: release, server: target, catalogIndex, force, codeFingerprint });
      if (decision.action === "skip") { res.outcome = "skip"; res.reason = decision.reason; log(`${target}: ${hash} (${release}) skip: ${decision.reason}`); continue; }

      const cand = await deps.buildCandidate({ hash, version: rawRelease, server: target, catalogIndex });

      if (verdict.pass) {
        if (!cand.ok) { fault(`gate passed but the candidate adapter cannot be rebuilt: ${cand.reason}`); continue; }
        res.outcome = "pass";
        if (dryRun) {
          log(`${target}: ${hash} gate PASSED; [dry-run] would publish catalog/adapters/${hash}.json and close the issue`);
        } else {
          const pub = await deps.publish({ port: github, hash, adapterFile: cand.file, catalogDir });
          if (pub.merged) dirty = true;
          if (!pub.ok) { fault(`publish failed at ${pub.stage}: ${pub.error}`); continue; }
          log(`${target}: ${hash} published (${pub.status ?? `PR #${pub.pr}`})`);
        }
        const rep = await deps.reportPass({ port: github, server: target, hash, version: release, runUrl });
        if (!rep.ok) fault(`closing the issue failed at ${rep.stage}: ${rep.error}`);
        else if (rep.truncated) warnings.push(`${target}: issue search was truncated`);
        res.closedIssues = rep.closed ?? [];
        continue;
      }

      // Gate failed: a normal outcome. Issue first (its number goes in the placeholder), then the placeholder.
      res.outcome = "fail";
      const why = gateSummary(verdict);
      res.gate = why;
      log(`${target}: ${hash} gate FAILED, ${why}`);
      const rep = await deps.reportFailure({ port: github, server: target, hash, version: release, gate: why, runUrl, candidate: cand.ok ? cand.file : undefined });
      let issue = null;
      if (!rep.ok) fault(`reporting the failure failed at ${rep.stage}: ${rep.error}`);
      else {
        issue = rep.issue;
        res.issue = issue;
        if (rep.labelMissing) warnings.push(`${target}: issue #${issue} could not be given the adapter-watch label`);
        if (rep.truncated) warnings.push(`${target}: issue search was truncated`);
        if (rep.extras?.length) warnings.push(`${target}: duplicate open issues ${rep.extras.map((n) => `#${n}`).join(", ")}`);
      }
      if (dryRun) {
        log(`${target}: [dry-run] would publish a needs-attention placeholder for ${hash} (issue ${issue ?? "none"})`);
      } else {
        // Published even when the issue write failed: otherwise the next hour would gate (and put avatars on the server) again.
        const pub = await deps.publish({ port: github, hash, placeholder: { server: target, version: release, gate: why, issue: issue ?? undefined, commit: codeFingerprint }, catalogDir });
        if (pub.merged) dirty = true;
        if (!pub.ok) fault(`placeholder publish failed at ${pub.stage}: ${pub.error}`);
      }
    } catch (e) {
      fault(`unexpected: ${msg(e)}`);
    }
  }
  return { results, faults, warnings };
}

/**
 * Both phases in one process (local runs, dry runs, tests). The verdicts still go through validateVerdict, so
 * this exercises exactly what the two-job workflow does. In this mode the job split is NOT a boundary: the token
 * is scrubbed from the environment (see main) only as defence in depth.
 *   options { phase: "all" | "gate" | "publish", verdictDir, ...phase options }
 */
export async function runWatch(deps, options = {}) {
  const { phase = "all", verdictDir } = options;
  if (phase === "gate") {
    const g = await runGatePhase(deps, options);
    if (verdictDir) writeVerdicts(verdictDir, g.verdicts);
    return g;
  }
  if (phase === "publish") return runPublishPhase({ ...deps, loadVerdict: (t) => readVerdictFile(verdictDir, t) }, options);
  const g = await runGatePhase(deps, options);
  const withVerdict = options.targets ?? TARGET_NAMES;
  const p = await runPublishPhase(
    { ...deps, loadVerdict: (t) => (g.verdicts.has(t) ? { raw: g.verdicts.get(t) } : null) },
    { ...options, syncFirst: false, targets: withVerdict.filter((t) => g.verdicts.has(t)) },
  );
  const results = g.results.map((r) => p.results.find((x) => x.target === r.target) ?? r);
  return { results, faults: [...g.faults, ...p.faults], warnings: [...g.warnings, ...p.warnings] };
}

// ---------------------------------------------------------------------------
// Real wiring
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { dryRun: false, force: false, hash: undefined, version: undefined, target: undefined, phase: "all", verdictDir: "verdicts" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--hash" || a === "--version" || a === "--target") out[a.slice(2)] = argv[++i];
    else if (a === "--phase") out.phase = argv[++i];
    else if (a === "--verdict-dir") out.verdictDir = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.target && !TARGET_NAMES.includes(out.target)) throw new Error(`--target must be one of ${TARGET_NAMES.join(", ")}`);
  if (!["all", "gate", "publish"].includes(out.phase)) throw new Error("--phase must be all, gate or publish");
  if (!out.verdictDir) throw new Error("--verdict-dir needs a directory");
  return out;
}

/** The code fingerprint from the local checkout's root tree (same value as the API's, without a token). */
export function localCodeFingerprint(cwd = repoRoot, exec = defaultGit) {
  const out = exec(["ls-tree", "-z", "HEAD"], { cwd });
  const entries = String(out).split("\0").filter(Boolean).map((l) => {
    const m = l.match(/^\d+ \w+ ([0-9a-f]{40})\t(.+)$/s);
    if (!m) throw new Error("unexpected git ls-tree output");
    return { path: m[2], sha: m[1] };
  });
  return fingerprintOf(entries);
}

const truthy = (v) => /^(1|true|yes)$/i.test(String(v ?? ""));
const TOKEN_VARS = ["GITHUB_TOKEN", "GH_TOKEN"];

/** Remove the write token from an environment so no child process (gate runners, Gradle) inherits it. */
export function scrubEnv(procEnv = process.env) {
  for (const k of TOKEN_VARS) delete procEnv[k];
}

function defaultGit(args, { cwd, env = {} }) {
  const base = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete base[k];
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...base, ...env } });
}

/**
 * Bring the local checkout level with origin/main after a merge. The token reaches git only through
 * GIT_CONFIG_* environment variables of the one fetch (never argv, never the checkout's .git/config).
 */
export function createSyncCheckout({ token, cwd = repoRoot, exec = defaultGit } = {}) {
  return async () => {
    exec(["checkout", "--", "catalog"], { cwd });
    exec(["clean", "-fdq", "--", "catalog"], { cwd });
    const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
    exec(["fetch", "--quiet", "origin", "main"], {
      cwd,
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` },
    });
    exec(["merge", "--ff-only", "FETCH_HEAD"], { cwd });
  };
}

/**
 * Entry point. `injected` is for tests: { deps (replaces the real wiring), procEnv (the environment to scrub), catalogDir }.
 * Returns the process exit code; throws on bad configuration.
 */
export async function main(argv = process.argv.slice(2), env = process.env, injected = {}) {
  // The token is captured here, before the environment is scrubbed, so any error text can still be cleaned of it.
  const secret = env.GITHUB_TOKEN;
  try {
    return await mainInner(argv, env, injected);
  } catch (e) {
    if (secret && String(e?.message ?? "").includes(secret)) e.message = e.message.split(secret).join("***");
    throw e;
  }
}

async function mainInner(argv, env, injected) {
  const args = parseArgs(argv);
  // Workflow inputs arrive through the environment (never interpolated into shell): ADAPTER_WATCH_* mirror the flags.
  const dryRun = args.dryRun || truthy(env.ADAPTER_WATCH_DRY_RUN);
  const force = args.force || truthy(env.ADAPTER_WATCH_FORCE);
  const only = parseOnly({ hash: args.hash ?? (env.ADAPTER_WATCH_HASH || undefined), version: args.version ?? (env.ADAPTER_WATCH_VERSION || undefined) });
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const writes = args.phase !== "gate"; // the gate phase makes no GitHub call at all: no token, no repo needed
  if (writes && !token) throw new Error("GITHUB_TOKEN is required");
  if (writes && !repo) throw new Error("GITHUB_REPOSITORY is required (owner/name)");
  // Only main publishes: a branch run would merge catalog changes built from branch code.
  if (writes && !dryRun && env.GITHUB_REF !== "refs/heads/main") throw new Error(`refusing to publish from ${env.GITHUB_REF ?? "an unknown ref"}: only refs/heads/main may publish (use dry_run elsewhere)`);
  const catalogDir = injected.catalogDir ?? path.join(repoRoot, "catalog");
  const log = (m) => console.log(m);
  const staging = {
    room: env.ADAPTER_WATCH_STAGING_ROOM || STAGING_FACTS.room,
    pusherUrl: env.ADAPTER_WATCH_STAGING_PUSHER || STAGING_FACTS.pusherUrl,
    wokaId: env.ADAPTER_WATCH_STAGING_WOKA || STAGING_FACTS.wokaId,
  };
  const areas = { production: env.ADAPTER_WATCH_AREA || DEFAULT_AREAS.production, staging: env.ADAPTER_WATCH_STAGING_AREA || DEFAULT_AREAS.staging };
  const runUrl = env.GITHUB_RUN_ID && /^\d+$/.test(env.GITHUB_RUN_ID) ? `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;

  const github = injected.deps || !writes ? undefined : createGithubPort({ repo, token });
  const deps = injected.deps ?? {
    github,
    // gate and publish jobs both fingerprint their own checkout (HEAD = github.sha); a single process asks the API.
    codeFingerprint: args.phase === "all" ? () => github.codeFingerprint() : () => localCodeFingerprint(),
    loadIndex: () => JSON.parse(fs.readFileSync(path.join(catalogDir, "index.json"), "utf8")),
    readServer: (t) => readServer(t),
    vendorProto: (server, release) => computeHashForVersion(server, release, { token }),
    buildCandidate: (a) => buildCandidate({ ...a, indexUrl: "https://raw.githubusercontent.com/" + (repo ?? "campey/workadventurer") + "/main/catalog/index.json" }),
    runGate,
    publish,
    reportPass,
    reportFailure,
    syncCheckout: createSyncCheckout({ token }),
    runnersFor: (server) => defaultRunners({ staging: { ...staging, area: areas.staging }, area: areas[server] }),
    tmpDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "adapter-watch-")),
  };
  // Defence in depth for `--phase all`: the token lives only in the port, the proto fetch and the sync closure, so
  // children (selfcheck, Gradle) never inherit it. This is NOT a boundary (a child could still read /proc/<pid>/environ
  // of this process's earlier state or use sudo); the real boundary is the workflow's two jobs: the gate job runs
  // `--phase gate` with a read-only token and never has a GitHub WRITE token (the publish job, which has the write token, runs no gate code).
  scrubEnv(injected.procEnv ?? process.env);
  log(`adapter watcher, phase ${args.phase}${dryRun ? " (dry run)" : ""}${force ? " (force)" : ""}`);
  const out = await runWatch(deps, { dryRun, force, only, targets: args.target ? [args.target] : TARGET_NAMES, runUrl, catalogDir, log, phase: args.phase, verdictDir: args.verdictDir });
  for (const r of out.results) log(`result ${r.target}: ${r.outcome}${r.hash ? ` ${r.hash}` : ""}${r.reason ? ` (${r.reason})` : ""}${r.gate ? ` gate=${r.gate}` : ""}`);
  for (const w of out.warnings) log(`::warning::${w}`);
  for (const f of out.faults) log(`::error::${f}`);
  return out.faults.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => { console.error(`adapter watcher: ${String(e?.message ?? e)}`); process.exit(1); }, // main() already scrubbed the token
  );
}
