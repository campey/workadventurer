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

import fs from "node:fs";
import path from "node:path";
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
 * Exactly one of the two.
 */
export async function publish({ port, hash, adapterFile, placeholder, catalogDir = DEFAULT_DIR, now = new Date() } = {}) {
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
      fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
      fs.writeFileSync(adapterPath, text);
      message = `Adapter ${hash}: add (gate passed)`;
      title = `Adapter ${hash} (gate passed)`;
    } else {
      const p = placeholder;
      if (!SERVERS.includes(p?.server)) return fail("validate", `placeholder server must be one of ${SERVERS.join(", ")}`);
      if (fs.existsSync(adapterPath)) return fail("validate", `${hash} already has an adapter file; not replacing it with a placeholder`);
      if (p.issue != null && !Number.isInteger(p.issue)) return fail("validate", "placeholder issue must be a number");
      let commit = p.commit;
      if (commit == null) commit = await port.mainCommit();
      if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/.test(commit)) return fail("validate", "placeholder commit must be a hex sha");
      const entry = {
        status: "needs-attention",
        server: p.server,
        version: normaliseVersion(p.server, p.version),
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
    const sha = await port.mainCommit();
    await port.createBranch(branch, sha);
    stage = "commit";
    await port.commit({ branch, message, files: out });
    stage = "pr";
    pr = (await port.findOpenPr(branch)) ?? (await port.openPr({
      branch,
      title,
      body: `${message}\n\nOpened by the adapter watcher (#127). Touches only catalog/.`,
    }));
    stage = "merge";
    const merged = await port.merge(pr.number);
    if (!merged || merged.merged !== true) return fail("merge", "GitHub did not merge the pull request", { pr: pr.number, branch });
  } catch (e) {
    return fail(stage, msg(e), pr ? { pr: pr.number, branch } : { branch });
  }
  return { ok: true, merged: true, branch, pr: pr.number, files: out.map((f) => f.path) };
}
