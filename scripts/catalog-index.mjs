// Rebuild catalog/index.json from catalog/adapters/*.json.
//   node scripts/catalog-index.mjs [catalogDir]
// One "ok" entry per adapter file (sha256 of its exact bytes); existing
// "needs-attention" placeholders (no file) are kept; keys are sorted so diffs stay
// stable. Fails loudly if a file does not validate or is misnamed. Also used by the
// version-watcher workflow, so the work lives in an importable rebuildIndex().
//
// Optional per-entry fields the watcher owns (clients ignore both, or keep them only when well-formed):
//   added   ISO instant the adapter was first listed `ok`. Set once for a NEW ok entry, preserved across rebuilds,
//           never rewritten. Staging pruning orders by it.
//   seenOn  [{ server, version, checked, gate }] outcomes of gating the same hash on the OTHER server (index only,
//           the adapter file is untouched). Preserved across rebuilds.
//
//   node scripts/catalog-index.mjs --backfill-added [catalogDir]
// one-off: sets `added` on ok entries that lack it from the git commit date that added each adapter file (no network).

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../src/adapters/index.mjs";
import { validateAdapterFile, isInstant } from "../src/catalog/schema.mjs";

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "catalog");

/** "1.34.4" -> "v1.34.4"; "master-118dd84c" -> "master@118dd84c" (the form the landing page shows). */
export function displayVersion(waVersion) {
  const m = waVersion.match(/^master-([0-9a-f]+)$/);
  if (m) return `master@${m[1]}`;
  return /^\d/.test(waVersion) ? `v${waVersion}` : waVersion;
}

/** Rebuild `<dir>/index.json`; returns the index written. Throws on an invalid or misnamed adapter file. */
export function rebuildIndex(dir = DEFAULT_DIR, { now = new Date() } = {}) {
  const indexPath = path.join(dir, "index.json");
  let previous = {};
  let raw = null;
  try {
    raw = fs.readFileSync(indexPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`${indexPath}: existing index could not be read (${e.message}); nothing was written. Fix or delete the file and rerun.`);
  }
  if (raw !== null) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${indexPath}: existing index could not be read (${e.message}); nothing was written. Fix or delete the file and rerun.`);
    }
    const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (!plain(parsed) || !plain(parsed.entries)) {
      throw new Error(`${indexPath}: existing index could not be read (no "entries" object); nothing was written. Fix or delete the file and rerun.`);
    }
    previous = parsed.entries;
  }
  const entries = {};
  for (const [hash, e] of Object.entries(previous)) {
    if (e?.status === "needs-attention" && e.file === undefined) entries[hash] = e;
  }
  const adaptersDir = path.join(dir, "adapters");
  for (const name of fs.readdirSync(adaptersDir).filter((f) => f.endsWith(".json")).sort()) {
    const hash = name.slice(0, -".json".length);
    const bytes = fs.readFileSync(path.join(adaptersDir, name));
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`${name}: not valid JSON`);
    }
    const checked = validateAdapterFile(parsed, ADAPTERS);
    if (!checked.ok) throw new Error(`${name}: ${checked.reason}`);
    if (checked.file.apiVersionHash !== hash) {
      throw new Error(`${name}: file name does not match its apiVersionHash ${checked.file.apiVersionHash}`);
    }
    const old = previous[hash];
    const wasOk = old?.status === "ok" && old.file !== undefined;
    // `added` is set once, for an entry that was not ok before; a legacy ok entry without it stays without
    // (the backfill sets it from git). `seenOn` rides along untouched.
    const added = wasOk ? (isInstant(old.added) ? old.added : undefined) : now.toISOString();
    entries[hash] = {
      status: "ok",
      server: checked.file.server,
      version: displayVersion(checked.file.waVersion),
      file: `adapters/${name}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      gate: null,
      issue: null,
      ...(added ? { added } : {}),
      ...(wasOk && Array.isArray(old.seenOn) && old.seenOn.length ? { seenOn: old.seenOn } : {}),
    };
  }
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const index = { schema: 1, updated: now.toISOString(), entries: sorted };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  return index;
}

/** The ISO instant (UTC) of the commit that added `file`, from git history only; null when unknown. */
export function gitAddedDate(file, { cwd = path.dirname(file), exec = execFileSync } = {}) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  const git = (...args) => String(exec("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env }));
  let lines;
  try { lines = git("log", "--diff-filter=A", "--format=%H %cI", "--", path.resolve(file)).split("\n").filter(Boolean); } catch { return null; }
  const last = lines[lines.length - 1]; // oldest add
  if (!last) return null;
  const [sha, when] = last.split(" ");
  if (Number.isNaN(Date.parse(when))) return null;
  let boundary = false;
  try {
    const shallow = path.resolve(cwd, git("rev-parse", "--git-path", "shallow").trim());
    boundary = fs.readFileSync(shallow, "utf8").split("\n").includes(sha);
  } catch { /* not shallow */ }
  return { iso: new Date(when).toISOString(), sha, shallowBoundary: boundary };
}

/** One-off: set `added` on every ok entry lacking it, from the git date of its adapter file. Returns { set, skipped }. */
export function backfillAdded(dir = DEFAULT_DIR, { now = new Date(), dateFor = gitAddedDate } = {}) {
  const indexPath = path.join(dir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const set = [];
  const skipped = [];
  for (const [hash, e] of Object.entries(index.entries ?? {})) {
    if (e?.status !== "ok" || isInstant(e.added)) continue;
    const found = dateFor(path.join(dir, "adapters", `${hash}.json`));
    if (!found) { skipped.push({ hash, why: "no git history for the adapter file" }); continue; }
    if (found.shallowBoundary) skipped.push({ hash, why: `date is a shallow-clone boundary commit (${found.sha.slice(0, 8)}), real add may be older`, used: true });
    e.added = found.iso;
    set.push({ hash, added: found.iso });
  }
  if (set.length) {
    index.updated = now.toISOString();
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  }
  return { set, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const backfill = args.includes("--backfill-added");
    const rest = args.filter((a) => a !== "--backfill-added");
    const dir = rest[0] ? path.resolve(rest[0]) : DEFAULT_DIR;
    if (backfill) {
      const r = backfillAdded(dir);
      for (const s of r.set) console.log(`added ${s.hash} ${s.added}`);
      for (const s of r.skipped) console.log(`${s.used ? "warning" : "skipped"} ${s.hash}: ${s.why}`);
      process.exit(0);
    }
    const index = rebuildIndex(dir);
    console.log(`catalog index: ${Object.keys(index.entries).length} entries`);
  } catch (e) {
    console.error(`catalog-index: ${e.message}`);
    process.exit(1);
  }
}
