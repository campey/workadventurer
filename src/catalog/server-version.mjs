// Read the server's own API hash. A WorkAdventure home page carries
// <meta name="wa-api-version" content="f4cfe455"> next to its release string
// (v1.34.4 on production, master@<sha> on staging).
//
// Pure helpers only: this module must not import src/adapters/index.mjs (that
// file imports matchApiHash from here), so the release matcher is injected.

import { HASH_RE } from "./schema.mjs";

/** The wa-api-version meta content if it is a valid hash; null otherwise. */
export function matchApiHash(html) {
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']wa-api-version["']/i.test(tag)) continue;
    const c = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    return c && HASH_RE.test(c[1]) ? c[1] : null;
  }
  return null;
}

/**
 * GET the room URL's origin and read { hash, release }; null on any failure or
 * when neither is found. Pass `matchRelease` (adapters' matchVersion) to fill
 * `release` with its `raw` string; without it release is null.
 */
export async function readServerVersion(
  roomUrl,
  { fetch: fetchFn = fetch, timeoutMs = 8000, matchRelease } = {}
) {
  try {
    const origin = new URL(roomUrl).origin;
    const res = await fetchFn(origin + "/", { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const html = await res.text();
    const hash = matchApiHash(html);
    const release = matchRelease?.(html)?.raw ?? null;
    return hash || release ? { hash, release } : null;
  } catch {
    return null;
  }
}
