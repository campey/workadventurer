// Adapter watcher orchestrator (#127): for production and staging, read the server, decide,
// then gate -> publish pass + close issue, or placeholder + issue. Run by
// .github/workflows/adapter-watch.yml; runnable locally with --dry-run.
//
//   node scripts/watch/run.mjs [--dry-run] [--force] [--hash <h>] [--version <v>] [--target production|staging]
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
import { readServer, decide, buildCandidate, computeHashForVersion } from "./candidate.mjs";
import { runGate, defaultRunners } from "./gate.mjs";
import { publish } from "./publish.mjs";
import { reportFailure, reportPass } from "./issues.mjs";
import { createGithubPort } from "./github-port.mjs";

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

/**
 * Run the watcher once.
 *   deps    { github, loadIndex(), readServer(t), vendorProto(server, release) -> { apiVersionHash, protoBuf },
 *             buildCandidate(a), runGate(a), publish(a), reportPass(a), reportFailure(a),
 *             syncCheckout(), runnersFor(server), tmpDir() }
 *   options { dryRun, force, only, targets, runUrl, catalogDir }
 * Returns { results: [{ target, outcome, ... }], faults: [string], warnings: [string] }.
 */
export async function runWatch(deps, { dryRun = false, force = false, only = {}, targets = TARGET_NAMES, runUrl, catalogDir, log = () => {} } = {}) {
  const results = [];
  const faults = [];
  const warnings = [];
  const github = dryRun ? dryRunPort(deps.github, log) : deps.github;
  let dirty = false; // a publish merged: the local checkout is behind main

  for (const target of targets) {
    const res = { target, outcome: "error" };
    results.push(res);
    const fault = (m) => { faults.push(`${target}: ${m}`); res.outcome = "fault"; res.error = m; log(`${target}: FAULT ${m}`); };
    try {
      if (dirty) {
        try { await deps.syncCheckout(); dirty = false; } catch (e) { fault(`could not refresh the checkout after a merge: ${msg(e)}`); continue; }
      }
      const server = await deps.readServer(target);
      if (!server) { fault("could not read the server's home page"); continue; }
      const { hash, release } = server;
      if (!hash || !HASH_RE.test(hash)) { fault("the home page names no api version hash"); continue; }
      res.hash = hash;
      res.version = release;
      if (only.hash && only.hash !== hash) { res.outcome = "skip"; res.reason = `not the requested hash ${only.hash}`; log(`${target}: ${hash} skipped, ${res.reason}`); continue; }

      const catalogIndex = deps.loadIndex();
      const mainCommit = await github.mainCommit();
      const decision = decide({ hash, version: release, server: target, catalogIndex, force, mainCommit });
      if (decision.action === "skip") { res.outcome = "skip"; res.reason = decision.reason; log(`${target}: ${hash} (${release}) skip: ${decision.reason}`); continue; }
      log(`${target}: ${hash} (${release}) gate: ${decision.reason}`);

      // The candidate adapter, then its proto (fetched from upstream by the release the page names).
      const cand = await deps.buildCandidate({ hash, version: release, server: target, catalogIndex });
      let gate;
      if (!cand.ok) {
        gate = { pass: false, steps: [{ name: "candidate", status: "fail", detail: cand.reason }] };
      } else {
        let vendored;
        try {
          vendored = await deps.vendorProto(target, release);
        } catch (e) { fault(`could not fetch the candidate proto: ${msg(e)}`); continue; }
        if (vendored.apiVersionHash !== hash) { fault(`upstream proto for ${release} hashes to ${vendored.apiVersionHash}, not the page's ${hash} (server moved mid-run?); try again`); continue; }
        const dir = deps.tmpDir();
        const candidateProto = path.join(dir, "messages.proto");
        fs.writeFileSync(candidateProto, Buffer.from(vendored.protoBuf));
        gate = await deps.runGate({ file: cand.file, server: target, candidateProto, runners: deps.runnersFor(target), log });
      }
      res.steps = gate.steps.map((s) => `${s.name}:${s.status}`);

      if (gate.pass) {
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
      const why = gateSummary(gate);
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
        const pub = await deps.publish({ port: github, hash, placeholder: { server: target, version: release, gate: why, issue: issue ?? undefined, commit: mainCommit }, catalogDir });
        if (pub.merged) dirty = true;
        if (!pub.ok) fault(`placeholder publish failed at ${pub.stage}: ${pub.error}`);
      }
    } catch (e) {
      fault(`unexpected: ${msg(e)}`);
    }
  }
  return { results, faults, warnings };
}

// ---------------------------------------------------------------------------
// Real wiring
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { dryRun: false, force: false, hash: undefined, version: undefined, target: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--hash" || a === "--version" || a === "--target") out[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.target && !TARGET_NAMES.includes(out.target)) throw new Error(`--target must be one of ${TARGET_NAMES.join(", ")}`);
  return out;
}

const truthy = (v) => /^(1|true|yes)$/i.test(String(v ?? ""));

function git(args, cwd) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  // Workflow inputs arrive through the environment (never interpolated into shell): ADAPTER_WATCH_* mirror the flags.
  const dryRun = args.dryRun || truthy(env.ADAPTER_WATCH_DRY_RUN);
  const force = args.force || truthy(env.ADAPTER_WATCH_FORCE);
  const only = parseOnly({ hash: args.hash ?? (env.ADAPTER_WATCH_HASH || undefined), version: args.version ?? (env.ADAPTER_WATCH_VERSION || undefined) });
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!repo) throw new Error("GITHUB_REPOSITORY is required (owner/name)");
  const catalogDir = path.join(repoRoot, "catalog");
  const log = (m) => console.log(m);
  const github = createGithubPort({ repo, token });
  const staging = {
    room: env.ADAPTER_WATCH_STAGING_ROOM || STAGING_FACTS.room,
    pusherUrl: env.ADAPTER_WATCH_STAGING_PUSHER || STAGING_FACTS.pusherUrl,
    wokaId: env.ADAPTER_WATCH_STAGING_WOKA || STAGING_FACTS.wokaId,
  };
  const areas = { production: env.ADAPTER_WATCH_AREA || DEFAULT_AREAS.production, staging: env.ADAPTER_WATCH_STAGING_AREA || DEFAULT_AREAS.staging };
  const runUrl = env.GITHUB_RUN_ID && /^\d+$/.test(env.GITHUB_RUN_ID) ? `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;

  const deps = {
    github,
    loadIndex: () => JSON.parse(fs.readFileSync(path.join(catalogDir, "index.json"), "utf8")),
    readServer: (t) => readServer(t),
    vendorProto: (server, release) => computeHashForVersion(server, release, { token }),
    buildCandidate: (a) => buildCandidate({ ...a, indexUrl: "https://raw.githubusercontent.com/" + repo + "/main/catalog/index.json" }),
    runGate,
    publish,
    reportPass,
    reportFailure,
    syncCheckout: async () => {
      git(["checkout", "--", "catalog"], repoRoot);
      git(["clean", "-fdq", "--", "catalog"], repoRoot);
      git(["pull", "--ff-only", "origin", "main"], repoRoot);
    },
    runnersFor: (server) => defaultRunners({ staging: { ...staging, area: areas.staging }, area: areas[server] }),
    tmpDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "adapter-watch-")),
  };
  log(`adapter watcher${dryRun ? " (dry run)" : ""}${force ? " (force)" : ""}`);
  const out = await runWatch(deps, { dryRun, force, only, targets: args.target ? [args.target] : TARGET_NAMES, runUrl, catalogDir, log });
  for (const r of out.results) log(`result ${r.target}: ${r.outcome}${r.hash ? ` ${r.hash}` : ""}${r.reason ? ` (${r.reason})` : ""}${r.gate ? ` gate=${r.gate}` : ""}`);
  for (const w of out.warnings) log(`::warning::${w}`);
  for (const f of out.faults) log(`::error::${f}`);
  return out.faults.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => { console.error(`adapter watcher: ${String(e?.message ?? e).split(String(process.env.GITHUB_TOKEN || "\0")).join("***")}`); process.exit(1); },
  );
}
