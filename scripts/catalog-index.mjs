// Rebuild catalog/index.json from catalog/adapters/*.json.
//   node scripts/catalog-index.mjs [catalogDir]
// One "ok" entry per adapter file (sha256 of its exact bytes); existing
// "needs-attention" placeholders (no file) are kept; keys are sorted so diffs stay
// stable. Fails loudly if a file does not validate or is misnamed. Also used by the
// version-watcher workflow, so the work lives in an importable rebuildIndex().

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../src/adapters/index.mjs";
import { validateAdapterFile } from "../src/catalog/schema.mjs";

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
    entries[hash] = {
      status: "ok",
      server: checked.file.server,
      version: displayVersion(checked.file.waVersion),
      file: `adapters/${name}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      gate: null,
      issue: null,
    };
  }
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const index = { schema: 1, updated: now.toISOString(), entries: sorted };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = rebuildIndex(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIR);
    console.log(`catalog index: ${Object.keys(index.entries).length} entries`);
  } catch (e) {
    console.error(`catalog-index: ${e.message}`);
    process.exit(1);
  }
}
