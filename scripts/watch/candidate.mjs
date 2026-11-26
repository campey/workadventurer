// Adapter watcher, step 1-2: read what a server is running, decide whether it
// needs the gate, and build the candidate adapter file the gate will test.
// Pure functions with injected fetch; nothing here touches the network on its own
// beyond what the caller passes in. See the spec's section 3 (#127).

import { readServerVersion } from "../../src/catalog/server-version.mjs";
import { matchVersion, ADAPTERS } from "../../src/adapters/index.mjs";
import { fetchAdapterFile } from "../../src/catalog/client.mjs";
import { validateAdapterFile } from "../../src/catalog/schema.mjs";
import { computeProtoHash } from "../vendor-proto.mjs";
import { displayVersion } from "../catalog-index.mjs";

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
  if (server === "staging") {
    const m = String(release).match(/^master@([0-9a-f]+)$/);
    if (!m) throw new Error(`staging release "${release}" does not name a master commit (expected master@<sha>)`);
    return computeProtoHash(m[1], { token, fetch });
  }
  if (!release) throw new Error("production release is missing");
  return computeProtoHash(String(release), { token, fetch });
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
    if (!best) best = { hash, entry: e };
    else if (server === "production") {
      if (cmpSemver(e.version, best.entry.version) >= 0) best = { hash, entry: e };
    } else if (hash > best.hash) best = { hash, entry: e };
  }
  return best;
}

/** The `seenOn` record for `server` on an index entry, or undefined. */
export function seenRecord(entry, server) {
  return Array.isArray(entry?.seenOn) ? entry.seenOn.find((r) => r?.server === server) : undefined;
}

/** True when the entry is an adapter clients may apply AND this server's own gate verdict is not a failure. */
export function okOnServer(entry, server) {
  if (entry?.status !== "ok") return false;
  if (entry.server === server) return true;
  const rec = seenRecord(entry, server);
  return rec?.gate === "passed";
}

/**
 * Decide whether a server hash needs the gate.
 *   skip: the hash is already `ok`, or it is `needs-attention` with no retest trigger.
 *   gate: new hash, or a retest trigger fired, or (`seenOn: true` in the result) an `ok` hash that the OTHER server
 *         announces and that has no record for this server yet.
 * Ownership (R13): a placeholder written by production is never re-gated or replaced from staging; production
 * gates over a staging-written placeholder once (and the new placeholder or ok entry is then production's).
 * Retest triggers for a `needs-attention` placeholder of the same server: `force` (manual run), the code
 * fingerprint differs from the placeholder's `commit` field, or the server's version
 * string differs from the placeholder's `version`. The `commit` field holds the CODE
 * FINGERPRINT (port.codeFingerprint(): sha1 of the root tree entries bin, src, scripts, world-port, android, proto, package.json and
 * package-lock.json, R14), not a git commit; neither catalog/ nor docs/ count: the watcher's own catalog merges must not retrigger a retest (R11).
 */
export function decide({ hash, version, server, catalogIndex, force = false, codeFingerprint }) {
  if (server !== "production" && server !== "staging") throw new Error(`decide: server must be production or staging, got "${server}"`);
  const e = catalogIndex?.entries?.[hash];
  if (!e) return { action: "gate", reason: "new hash" };
  if (e.status === "ok") {
    // An ok hash gated on its own server is done. Announced by the OTHER server it has no record there yet: gate it
    // once (index-only `seenOn`, the adapter file never changes). After that, a pass is final and a fail retests only on
    // the placeholder triggers (force, code fingerprint, version), so this never loops.
    if (e.server === server) return { action: "skip", reason: "already ok" };
    const rec = seenRecord(e, server);
    if (!rec) return { action: "gate", reason: `ok for ${e.server}, not yet gated on ${server}`, seenOn: true };
    if (rec.gate === "passed") return { action: "skip", reason: `already ok, gated on ${server}` };
    if (force) return { action: "gate", reason: "manual run", seenOn: true };
    if (codeFingerprint && rec.commit !== codeFingerprint) return { action: "gate", reason: "code changed since the failed gate", seenOn: true };
    const shown = normaliseVersion(server, version);
    if (shown && shown !== normaliseVersion(server, rec.version)) return { action: "gate", reason: "server version changed", seenOn: true };
    return { action: "skip", reason: `ok, gate failed on ${server}, nothing changed` };
  }
  if (e.status !== "needs-attention") return { action: "gate", reason: `entry status "${e.status}"` };
  // R13: production and staging can show the same hash. Production owns it: staging never gates or overwrites a
  // placeholder production wrote; production over a staging-written one gates once and takes ownership.
  if (server === "staging" && e.server === "production") return { action: "skip", reason: "owned by production" };
  if (server === "production" && e.server === "staging") return { action: "gate", reason: "production takes over a staging placeholder" };
  if (force) return { action: "gate", reason: "manual run" };
  if (codeFingerprint && e.commit !== codeFingerprint) return { action: "gate", reason: "code changed since the placeholder" };
  const shown = normaliseVersion(server, version);
  if (shown && shown !== normaliseVersion(server, e.version)) return { action: "gate", reason: "server version changed" };
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

/** The form the index stores: v1.34.5, master@<8 hex>. Unnameable versions come back as given. */
export function normaliseVersion(server, version) {
  if (!version) return null;
  const wa = waVersionFor(server, version);
  return wa ? displayVersion(wa) : String(version);
}

const NUMBER_KEYS = ["meeting", "movement", "handshake"];

/**
 * Build the candidate adapter file for `hash` running `version` on `server`.
 * Base = the newest `ok` entry for that server (its file is fetched through
 * `fetchBase`, default: the catalog client, sha256-checked); its protoFamily and
 * behaviour numbers are copied. Staging with no base falls back to wa-master with
 * no numbers. Returns { ok: true, file, base } or { ok: false, reason }.
 */
export async function buildCandidate({ hash, version, server, catalogIndex, indexUrl, fetch, builtins = ADAPTERS, fetchBase, useExisting = false }) {
  const get = fetchBase ?? ((h, entry) => fetchAdapterFile({ indexUrl, hash: h, entry, builtins, fetch }));
  if (useExisting) {
    // The hash is already an `ok` catalog adapter (gated on the other server): test exactly what clients apply, the
    // catalog's own file, on this server. Nothing is built, so the file can never differ from the published bytes.
    const entry = catalogIndex?.entries?.[hash];
    if (entry?.status !== "ok") return { ok: false, reason: `no ok catalog entry for ${hash}` };
    const got = await get(hash, entry);
    if (!got?.ok) return { ok: false, reason: `adapter ${hash}: ${got?.reason ?? "could not be read"}` };
    if (got.file?.apiVersionHash !== hash) return { ok: false, reason: `adapter ${hash}: file's apiVersionHash is ${got.file?.apiVersionHash}` };
    return { ok: true, file: got.file, base: null, existing: true };
  }
  const waVersion = waVersionFor(server, version);
  if (!waVersion) return { ok: false, reason: `cannot name an adapter for ${server} version "${version}"` };
  const base = pickBase(catalogIndex, server);
  let baseFile = null;
  if (base) {
    const got = await get(base.hash, base.entry);
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
