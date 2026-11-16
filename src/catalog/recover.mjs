// Recover an adapter for a server hash nothing built in knows (#126): read the
// server's hash, look it up in the catalog, and (with consent) download, verify
// and cache the adapter file. Never throws and never hangs: any failure to read
// the page or the catalog is { status: "unavailable" } and `wa join` carries on.
//
// Must not import src/adapters/index.mjs (it imports from this directory); the
// built-ins and the release matcher are parameters.

import { readServerVersion } from "./server-version.mjs";
import { fetchIndex, fetchAdapterFile, catalogUrl } from "./client.mjs";
import { saveCached, loadCached } from "./store.mjs";
import { buildAdapter } from "./schema.mjs";

const unavailable = (reason) => ({ status: "unavailable", reason });

/** One line out of a needs-attention placeholder's `gate` (a string or an object summary). */
// The text is untrusted and ends up on the terminal: control characters become
// spaces and the length is capped.
const MAX_DETAIL = 200;
function gateDetail(gate) {
  if (gate == null) return undefined;
  let text;
  if (typeof gate === "string") text = gate;
  else { try { text = JSON.stringify(gate); } catch { text = String(gate); } }
  text = String(text ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

export async function recoverAdapter({
  roomUrl, mode, ask, onAlways, fetch, indexUrl = catalogUrl(), dir, builtins, matchRelease, timeoutMs, log = () => {},
}) {
  try {
    const version = await readServerVersion(roomUrl, { fetch, timeoutMs, matchRelease });
    const hash = version?.hash;
    if (!hash) return unavailable("could not read the server's version hash");

    if (Object.values(builtins).some((a) => a.apiVersionHashes?.includes(hash))) return { status: "known", hash };
    // Known only if the cache file actually loads; a bad file is overwritten below.
    if (await loadCached(hash, { dir, builtins })) return { status: "known", hash };

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

/**
 * The onAlways callback for `wa join`: the session switches to auto first (the daemon
 * it starts gets WA_ADAPTER_UPDATES from cfg), then the choice is written to the config
 * file; a refused write throws and recoverAdapter logs it.
 */
export function alwaysHandler(cfg, write) {
  return () => {
    cfg.adapterUpdates = "auto";
    write("adapterUpdates", "auto");
  };
}

const HOW_TO_ALLOW =
  "to allow the download, run `wa join` again and answer y, or set adapterUpdates to auto (WA_ADAPTER_UPDATES=auto)";
const HOW_TO_ALLOW_NEVER =
  "to allow the download, set adapterUpdates to ask or auto (config file key, or WA_ADAPTER_UPDATES=ask)";

/** The message `wa join` prints before exiting for a refusing outcome; null for the others. */
export function refusalMessage(o) {
  if (o.status === "unsupported" && o.reason === "no-entry") {
    return `no adapter for this server version yet (${o.hash})`;
  }
  if (o.status === "unsupported") {
    return `this server version isn't supported yet, it needs attention (${o.hash})${o.detail ? `: ${o.detail}` : ""}`;
  }
  if (o.status === "declined" || o.status === "never") {
    return `an adapter for this server version (${o.hash}) is available but was not downloaded; ${o.status === "never" ? HOW_TO_ALLOW_NEVER : HOW_TO_ALLOW}`;
  }
  return null;
}
