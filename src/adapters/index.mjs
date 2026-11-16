// Version-target registry + resolver. Given a room URL, decide which adapter
// (proto + apiVersionHash + behaviours) to talk to the server with. See
// docs/superpowers/specs/2026-09-10-wa-version-adapters-design.md.

import wa133 from "./wa-1.33.mjs";
import wa134 from "./wa-1.34.mjs";
import waMaster from "./wa-master.mjs";
import { matchApiHash } from "../catalog/server-version.mjs";

export const ADAPTERS = {
  "wa-1.33": wa133,
  "wa-1.34": wa134,
  "wa-master": waMaster,
};

// Released adapters, oldest first; last is "newest released".
const RELEASED = [wa133, wa134];

// Fallback when the probe can't reach or parse the server.
const HOST_ALLOWLIST = {
  "play.workadventu.re": "wa-1.34",
};

/** Pull a version marker out of a WorkAdventure landing page. */
export function matchVersion(html) {
  const rel = html.match(/v(\d+)\.(\d+)\.\d+/);
  if (rel) return { kind: "release", minor: `${rel[1]}.${rel[2]}`, raw: rel[0] };
  const m = html.match(/master@([0-9a-f]{7,40})/);
  if (m) return { kind: "master", sha: m[1], raw: m[0] };
  return null;
}

/** GET the server's landing page and read its version marker; null on any failure. */
export async function probeVersion(roomUrl) {
  let origin;
  try {
    origin = new URL(roomUrl).origin;
  } catch {
    return null;
  }
  try {
    const res = await fetch(origin + "/", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    const version = matchVersion(html);
    const hash = matchApiHash(html);
    if (!hash) return version;
    return { ...(version ?? {}), hash };
  } catch {
    return null;
  }
}

const shaDrift = (a, b) => !(a.startsWith(b) || b.startsWith(a));

/**
 * Resolve a target adapter. Precedence: explicit override > cached catalog
 * adapter for the probed hash > server probe > host allowlist > warned default
 * (wa-1.33). `cachedFor` is injected by the outer layer so the core client
 * never touches the catalog cache; it only runs for a hash no built-in knows.
 * @param {{roomUrl?:string, override?:string, probeFn?:(url:string)=>Promise<any>, cachedFor?:(hash:string)=>Promise<object|null>}} opts
 */
export async function resolveAdapter({ roomUrl, override, probeFn = probeVersion, cachedFor } = {}) {
  if (override && override !== "auto") {
    const a = ADAPTERS[override];
    if (!a) {
      throw new Error(
        `unknown target "${override}" (known: ${Object.keys(ADAPTERS).join(", ")})`
      );
    }
    return { adapter: a, why: `explicit target ${override}` };
  }

  const probe = roomUrl ? await probeFn(roomUrl) : null;

  if (cachedFor && probe?.hash && !Object.values(ADAPTERS).some((a) => a.apiVersionHashes?.includes(probe.hash))) {
    try {
      const cached = await cachedFor(probe.hash);
      if (cached) {
        return { adapter: cached, why: `catalog adapter ${cached.id} (${probe.hash}) from the local cache` };
      }
    } catch {
      /* a broken cache must never break connecting: fall through */
    }
  }

  if (probe?.kind === "release") {
    const key = `wa-${probe.minor}`;
    if (ADAPTERS[key]) return { adapter: ADAPTERS[key], why: `probed ${probe.raw}` };
    const newest = RELEASED[RELEASED.length - 1];
    return {
      adapter: newest,
      why:
        `probed ${probe.raw} — no ${key} adapter, using ${newest.id} behaviours; ` +
        `the server may reject its hash (NEW_VERSION) — see "When prod bumps" in docs/field-notes.md`,
      warn: true,
    };
  }

  if (probe?.kind === "master") {
    const a = ADAPTERS["wa-master"];
    const drift = a.trackedSha && shaDrift(probe.sha, a.trackedSha);
    return {
      adapter: a,
      why: drift
        ? `probed master@${probe.sha} — adapter tracks master@${a.trackedSha} (${a.verifiedDate}), behaviours may have drifted`
        : `probed master@${probe.sha}`,
      ...(drift ? { warn: true } : {}),
    };
  }

  try {
    const host = new URL(roomUrl).host;
    if (HOST_ALLOWLIST[host]) {
      return { adapter: ADAPTERS[HOST_ALLOWLIST[host]], why: `host allowlist (${host})` };
    }
  } catch {
    /* fall through */
  }

  return { adapter: wa133, why: "default (probe failed, host not in allowlist)", warn: true };
}
