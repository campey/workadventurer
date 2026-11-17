// Adapter watcher, step 1-2: read what a server is running, decide whether it
// needs the gate, and build the candidate adapter file the gate will test.
// Pure functions with injected fetch; nothing here touches the network on its own
// beyond what the caller passes in. See the spec's section 3 (#127).

import { readServerVersion } from "../../src/catalog/server-version.mjs";
import { matchVersion, ADAPTERS } from "../../src/adapters/index.mjs";
import { fetchAdapterFile } from "../../src/catalog/client.mjs";
import { validateAdapterFile } from "../../src/catalog/schema.mjs";
import { computeProtoHash } from "../vendor-proto.mjs";

export const TARGETS = {
  production: "https://play.workadventu.re/",
  staging: "https://play.staging.workadventu.re/",
};

/** Read { hash, release } from a server's home page; null when unreachable or unreadable. */
export function readServer(target, { fetch, timeoutMs } = {}) {
  const url = TARGETS[target];
  if (!url) throw new Error(`unknown target "${target}"`);
  return readServerVersion(url, { fetch, timeoutMs, matchRelease: matchVersion });
}

/** The upstream hash for a release tag or the `master` commit the page names (GITHUB_TOKEN raises the rate limit). */
export function computeHashForVersion(server, release, { token, fetch } = {}) {
  const m = String(release).match(/^master@([0-9a-f]{7,40})$/);
  const ref = server === "staging" && m ? m[1] : String(release);
  return computeProtoHash(ref, { token, fetch });
}

const semverKey = (v) => (String(v).match(/\d+/g) ?? []).map(Number);
function cmpSemver(a, b) {
  const [x, y] = [semverKey(a), semverKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The newest `ok` entry for a server: highest release number for production. Staging
 * versions are commits with no order the index records, so the last by hash order is
 * taken (deterministic, and any staging entry carries equally current numbers).
 */
export function pickBase(catalogIndex, server) {
  let best = null;
  for (const [hash, e] of Object.entries(catalogIndex?.entries ?? {})) {
    if (e?.status !== "ok" || e.server !== server) continue;
    if (!best || (server === "production" ? cmpSemver(e.version, best.entry.version) >= 0 : true)) best = { hash, entry: e };
  }
  return best;
}

/**
 * Decide whether a server hash needs the gate.
 *   skip: the hash is already `ok`, or it is `needs-attention` with no retest trigger.
 *   gate: new hash, or a retest trigger fired.
 * Retest triggers for a `needs-attention` placeholder: `force` (manual run), the
 * `main` commit differs from the placeholder's `commit`, or the server's version
 * string differs from the placeholder's `version`.
 */
export function decide({ hash, version, catalogIndex, force = false, mainCommit }) {
  const e = catalogIndex?.entries?.[hash];
  if (!e) return { action: "gate", reason: "new hash" };
  if (e.status === "ok") return { action: "skip", reason: "already ok" };
  if (e.status !== "needs-attention") return { action: "gate", reason: `entry status "${e.status}"` };
  if (force) return { action: "gate", reason: "manual run" };
  if (mainCommit && e.commit !== mainCommit) return { action: "gate", reason: "main changed since the placeholder" };
  if (version && e.version !== version) return { action: "gate", reason: "server version changed" };
  return { action: "skip", reason: "needs-attention, nothing changed" };
}

/** "v1.34.5" -> { waVersion: "1.34.5" }; "master@118dd84cabc" -> { waVersion: "master-118dd84c" }. */
export function waVersionFor(server, version) {
  if (server === "staging") {
    const m = String(version).match(/^master[@-]([0-9a-f]{7,40})$/);
    return m ? `master-${m[1].slice(0, 8)}` : null;
  }
  const m = String(version).match(/^v?(\d+\.\d+\.\d+)$/);
  return m ? m[1] : null;
}

const NUMBER_KEYS = ["meeting", "movement", "handshake"];

/**
 * Build the candidate adapter file for `hash` running `version` on `server`.
 * Base = the newest `ok` entry for that server (its file is fetched through
 * `fetchBase`, default: the catalog client, sha256-checked); its protoFamily and
 * behaviour numbers are copied. Staging with no base falls back to wa-master with
 * no numbers. Returns { ok: true, file, base } or { ok: false, reason }.
 */
export async function buildCandidate({ hash, version, server, catalogIndex, indexUrl, fetch, builtins = ADAPTERS, fetchBase }) {
  const waVersion = waVersionFor(server, version);
  if (!waVersion) return { ok: false, reason: `cannot name an adapter for ${server} version "${version}"` };
  const base = pickBase(catalogIndex, server);
  let baseFile = null;
  if (base) {
    const got = await (fetchBase ?? ((h, entry) => fetchAdapterFile({ indexUrl, hash: h, entry, builtins, fetch })))(base.hash, base.entry);
    if (!got?.ok) return { ok: false, reason: `base adapter ${base.hash}: ${got?.reason ?? "could not be read"}` };
    baseFile = got.file;
  } else if (server !== "staging") {
    return { ok: false, reason: `no ok catalog entry for ${server} to use as a base` };
  }
  const file = {
    schema: 1,
    id: `wa-${waVersion}`,
    waVersion,
    apiVersionHash: hash,
    server,
    protoFamily: baseFile?.protoFamily ?? "wa-master",
  };
  for (const k of NUMBER_KEYS) if (baseFile?.[k] !== undefined) file[k] = structuredClone(baseFile[k]);
  const checked = validateAdapterFile(file, builtins);
  if (!checked.ok) return { ok: false, reason: `candidate invalid: ${checked.reason}` };
  return { ok: true, file: checked.file, base: base ? base.hash : null };
}
