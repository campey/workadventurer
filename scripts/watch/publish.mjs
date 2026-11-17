// Adapter watcher, steps 4-5: publish a verdict through the pull request route (#127).
//
//   pass  -> catalog/adapters/<hash>.json + rebuilt catalog/index.json
//   fail  -> a `needs-attention` placeholder in catalog/index.json
//
// Both go on branch `adapter/<hash>`, in a PR touching only catalog/, merged from the
// workflow (main requires a PR, 0 approvals; the PR depends on no other check). The
// local files are written under `catalogDir` (a checkout of main), then read back and
// committed through the GitHub port. publish never throws: every failure comes back
// as { ok: false, stage, error }. A re-run reuses the branch (reset to main) and any
// open PR for it. If the merge fails, main is untouched (the PR stays open for a
// re-run) and the failure is reported.
//
// Safety: the merge is pinned. The branch is cut from main's tip (mainSha), the commit's
// parent is exactly that sha, and merge() is told the commit sha it expects the PR head
// to be (GitHub answers 409 if anyone moved the branch). An existing open PR is reused
// only if its head is our commit and from this repo.
// Stale checkout: the files are built from the local checkout, so its commit
// (`checkoutCommit`, default `git rev-parse HEAD` in catalogDir) must equal main's tip,
// else stage "stale" (the workflow re-checks out main and re-runs). This is simpler and
// safer than rebuilding the index from the remote tree.
// An existing adapter file is never replaced: identical bytes is "already-published"
// (success, no PR); different bytes fails at "validate".

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HASH_RE, validateAdapterFile } from "../../src/catalog/schema.mjs";
import { ADAPTERS } from "../../src/adapters/index.mjs";
import { gateDetail } from "../../src/catalog/recover.mjs";
import { rebuildIndex } from "../catalog-index.mjs";
import { normaliseVersion } from "./candidate.mjs";
import { assertCatalogPaths, branchFor } from "./github-port.mjs";

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "catalog");
const SERVERS = ["production", "staging"];

const msg = (e) => String(e?.message ?? e).slice(0, 300);
const fail = (stage, error, extra = {}) => ({ ok: false, stage, error, ...extra });

/**
 * publish({ port, hash, adapterFile?, placeholder?, catalogDir?, now? })
 *   adapterFile: the validated adapter (object or exact text)  -> a pass
 *   placeholder: { server, version, gate, issue?, commit? }     -> a fail verdict
 *     `commit` is REQUIRED and holds the code fingerprint (port.codeFingerprint(), see decide() in candidate.mjs),
 *     not a git commit.
 * Exactly one of the two.
 */
export async function publish({ port, hash, adapterFile, placeholder, catalogDir = DEFAULT_DIR, now = new Date(), checkoutCommit, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, maxWaitMs = 15000 } = {}) {
  let branch;
  try {
    branch = branchFor(hash);
  } catch (e) {
    return fail("validate", msg(e));
  }
  if ((adapterFile === undefined) === (placeholder === undefined)) {
    return fail("validate", "give exactly one of adapterFile (pass) or placeholder (fail)");
  }

  const adapterRel = `catalog/adapters/${hash}.json`;
  const indexRel = "catalog/index.json";
  const adapterPath = path.join(catalogDir, "adapters", `${hash}.json`);
  const indexPath = path.join(catalogDir, "index.json");
  const files = [adapterFile !== undefined ? { path: adapterRel } : null, { path: indexRel }].filter(Boolean);
  try {
    assertCatalogPaths(files.map((f) => f.path));
  } catch (e) {
    return fail("validate", msg(e));
  }

  let mainSha;
  try {
    mainSha = await port.mainCommit();
  } catch (e) {
    return fail("branch", msg(e));
  }
  let local = checkoutCommit;
  if (local === undefined) {
    // Default: the checkout's own HEAD, and it must be clean under catalogDir (a dirty
    // tree would publish uncommitted edits). GIT_DIR and friends are dropped so an
    // inherited environment cannot point git at another repository.
    const env = { ...process.env };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[k];
    const git = (...args) => execFileSync("git", ["-C", catalogDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env });
    try {
      local = git("rev-parse", "HEAD").trim();
      if (git("status", "--porcelain", "--", ".").trim() !== "") {
        return fail("stale", "the catalog checkout has uncommitted changes; use a clean checkout of main");
      }
    } catch { local = null; }
  }
  if (local !== mainSha) {
    return fail("stale", `the local checkout (${local ?? "unknown commit"}) is not main's current commit (${mainSha}); check out main again and re-run`);
  }

  // Local files first, restored if anything below fails before the PR exists.
  const snapshot = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const before = { adapter: snapshot(adapterPath), index: snapshot(indexPath) };
  const restore = () => {
    for (const [p, b] of [[adapterPath, before.adapter], [indexPath, before.index]]) {
      try { if (b === null) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, b); } catch { /* best effort */ }
    }
  };

  let message;
  let title;
  try {
    if (adapterFile !== undefined) {
      const text = typeof adapterFile === "string" ? adapterFile : JSON.stringify(adapterFile, null, 2) + "\n";
      let parsed;
      try { parsed = JSON.parse(text); } catch { return fail("validate", "adapter file is not valid JSON"); }
      const checked = validateAdapterFile(parsed, ADAPTERS);
      if (!checked.ok) return fail("validate", `adapter file invalid: ${checked.reason}`);
      if (checked.file.apiVersionHash !== hash) return fail("validate", `adapter file's apiVersionHash is ${checked.file.apiVersionHash}, not ${hash}`);
      if (before.adapter !== null) {
        if (!before.adapter.equals(Buffer.from(text))) return fail("validate", `${hash} already has a different adapter file in the catalog; refusing to replace it`);
        // Identical file: done only if the index already lists it as ok with this file's sha256;
        // otherwise (e.g. a leftover needs-attention entry) go on and publish the repaired index.
        let entry = null;
        try { entry = JSON.parse(before.index?.toString("utf8") ?? "null")?.entries?.[hash]; } catch { /* treat as missing */ }
        const sha256 = createHash("sha256").update(before.adapter).digest("hex");
        if (entry?.status === "ok" && entry.sha256 === sha256) return { ok: true, merged: false, status: "already-published", branch, files: [] };
      } else {
        fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
        fs.writeFileSync(adapterPath, text);
      }
      message = `Adapter ${hash}: add (gate passed)`;
      title = `Adapter ${hash} (gate passed)`;
    } else {
      const p = placeholder;
      if (!SERVERS.includes(p?.server)) return fail("validate", `placeholder server must be one of ${SERVERS.join(", ")}`);
      if (fs.existsSync(adapterPath)) return fail("validate", `${hash} already has an adapter file; not replacing it with a placeholder`);
      if (p.issue != null && !Number.isInteger(p.issue)) return fail("validate", "placeholder issue must be a number");
      // The code fingerprint is required (callers read it from the port): there is no sensible default, and a
      // main commit sha here would make every merge look like a code change.
      const commit = p.commit;
      if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/.test(commit)) return fail("validate", "placeholder commit must be the code fingerprint (hex)");
      const version = normaliseVersion(p.server, p.version);
      if (version != null && !/^[\w.@-]{1,40}$/.test(version)) return fail("validate", "placeholder version has unexpected characters or is too long");
      const entry = {
        status: "needs-attention",
        server: p.server,
        version,
        gate: gateDetail(p.gate) ?? null,
        issue: p.issue ?? null,
        commit,
      };
      let index = { schema: 1, updated: now.toISOString(), entries: {} };
      if (before.index !== null) index = JSON.parse(before.index.toString("utf8"));
      index.entries[hash] = entry;
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
      message = `Adapter ${hash}: needs attention (gate failed)`;
      title = `Adapter ${hash} needs attention`;
    }
    rebuildIndex(catalogDir, { now });
  } catch (e) {
    restore();
    return fail("write", msg(e));
  }

  const out = files.map((f) => ({ path: f.path, content: fs.readFileSync(path.join(catalogDir, f.path.slice("catalog/".length)), "utf8") }));
  let pr;
  let stage = "branch";
  try {
    await port.createBranch(branch, mainSha);
    stage = "commit";
    const made = await port.commit({ branch, message, files: out, parent: mainSha });
    const commitSha = made?.sha;
    if (typeof commitSha !== "string" || !commitSha) throw new Error("commit returned no sha");
    stage = "pr";
    let existing = await port.findOpenPr(branch);
    if (existing) {
      stage = "merge";
      // GitHub moves a PR's head asynchronously after the ref update: wait briefly for ours.
      // (The sha pin on merge stays the authoritative check.)
      for (let waited = 0; existing && existing.headSha !== commitSha && waited < maxWaitMs; waited += pollMs) {
        await sleep(pollMs);
        existing = await port.findOpenPr(branch);
      }
      if (!existing || existing.headSha !== commitSha || !port.repo || existing.headRepo !== port.repo) {
        throw new Error(`open PR #${existing?.number ?? "?"} on ${branch} is not our commit or not from this repo; not merging it`);
      }
    }
    pr = existing ?? (await port.openPr({
      branch,
      title,
      body: `${message}\n\nOpened by the adapter watcher (#127). Touches only catalog/.`,
    }));
    stage = "merge";
    const merged = await port.merge(pr.number, { expectedHeadSha: commitSha });
    if (!merged || merged.merged !== true) { restore(); return fail("merge", "GitHub did not merge the pull request", { pr: pr.number, branch }); }
  } catch (e) {
    restore();
    return fail(stage, msg(e), pr ? { pr: pr.number, branch } : { branch });
  }
  return { ok: true, merged: true, branch, pr: pr.number, files: out.map((f) => f.path) };
}
