// Recover an adapter for a server hash nothing built in knows (#126): read the
// server's hash, look it up in the catalog, and (with consent) download, verify
// and cache the adapter file. Never throws and never hangs: any failure to read
// the page or the catalog is { status: "unavailable" } and `wa join` carries on.
//
// Must not import src/adapters/index.mjs (it imports from this directory); the
// built-ins and the release matcher are parameters.

import { readServerVersion } from "./server-version.mjs";
import { fetchIndex, fetchAdapterFile, catalogUrl } from "./client.mjs";
import { saveCached, cachedHashes } from "./store.mjs";
import { buildAdapter } from "./schema.mjs";

const unavailable = (reason) => ({ status: "unavailable", reason });

/** One line out of a needs-attention placeholder's `gate` (a string or an object summary). */
function gateDetail(gate) {
  if (gate == null) return undefined;
  if (typeof gate === "string") return gate;
  try { return JSON.stringify(gate); } catch { return String(gate); }
}

export async function recoverAdapter({
  roomUrl, mode, ask, onAlways, fetch, indexUrl = catalogUrl(), dir, builtins, matchRelease, timeoutMs, log = () => {},
}) {
  try {
    const version = await readServerVersion(roomUrl, { fetch, timeoutMs, matchRelease });
    const hash = version?.hash;
    if (!hash) return unavailable("could not read the server's version hash");

    if (Object.values(builtins).some((a) => a.apiVersionHashes?.includes(hash))) return { status: "known", hash };
    if ((await cachedHashes({ dir })).has(hash)) return { status: "known", hash };

    const idx = await fetchIndex({ url: indexUrl, fetch, timeoutMs });
    if (!idx.ok) return unavailable(idx.reason);
    const entry = idx.index.entries[hash];
    if (!entry) return { status: "unsupported", hash, reason: "no-entry" };
    if (entry.status === "needs-attention") {
      const detail = gateDetail(entry.gate);
      return { status: "unsupported", hash, reason: "needs-attention", ...(detail ? { detail } : {}) };
    }
    if (mode === "never") return { status: "never", hash };

    if (mode === "ask") {
      // No way to ask means no consent: never download silently.
      const answer = ask ? await ask(`This server has a new world adapter for ${version.release ?? hash}. Download it?`) : "no";
      // Fail closed: only an exact "yes" or "always" is consent.
      if (answer !== "yes" && answer !== "always") return { status: "declined", hash };
      if (answer === "always") {
        try { onAlways?.(); } catch (e) { log(`could not remember your choice: ${e.message}`); }
      }
    }

    const got = await fetchAdapterFile({ indexUrl: idx.url, hash, entry, builtins, fetch, timeoutMs });
    if (!got.ok) return unavailable(got.reason);
    await saveCached(hash, got.text, { dir });
    return { status: "applied", hash, adapter: buildAdapter(got.file, builtins) };
  } catch (e) {
    return unavailable(e?.message ?? String(e));
  }
}

const HOW_TO_ALLOW =
  "to allow the download, run `wa join` again and answer y, or set adapterUpdates to auto (WA_ADAPTER_UPDATES=auto)";

/** The message `wa join` prints before exiting for a refusing outcome; null for the others. */
export function refusalMessage(o) {
  if (o.status === "unsupported" && o.reason === "no-entry") {
    return `no adapter for this server version yet (${o.hash})`;
  }
  if (o.status === "unsupported") {
    return `this server version isn't supported yet, it needs attention (${o.hash})${o.detail ? `: ${o.detail}` : ""}`;
  }
  if (o.status === "declined" || o.status === "never") {
    return `an adapter for this server version (${o.hash}) is available but was not downloaded; ${HOW_TO_ALLOW}`;
  }
  return null;
}
