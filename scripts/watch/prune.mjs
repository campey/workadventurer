// Adapter watcher: staging pruning (#127 follow-up). Pure planning; publish.mjs does the file work.
//
// Rule, applied in the same PR as a newly published STAGING adapter:
//   * keep the newest KEEP_STAGING `ok` entries with `server: staging`, ordered by `added` (an entry without it
//     counts as oldest), ties by hash, higher hash newer. The entry being published is always kept.
//   * a hash either server announces in this run is never pruned (its seenOn publish may have faulted).
//   * production entries (`server: production`) are kept forever.
//   * never pruned, even beyond the newest five: a built-in hash (src/adapters), an entry with `server: production`,
//     and an entry with a production `seenOn` record (production runs it).
//   * a `needs-attention` placeholder for staging is dropped once a newer staging entry is ok (any new staging
//     publish is newer than every placeholder: placeholders carry no date). Production placeholders stay.
// The plan names adapter hashes to delete (files under catalog/adapters/ only) and placeholder hashes to drop.

import { HASH_RE } from "../../src/catalog/schema.mjs";

export const KEEP_STAGING = 5;

const time = (e) => { const t = Date.parse(e?.added); return Number.isNaN(t) ? 0 : t; };

export function planPrune(index, { keepHash, isBuiltin, announced = [], keep = KEEP_STAGING } = {}) {
  const live = new Set(announced); // hashes a server announces in this run: a pending seenOn publish must not lose its file
  const entries = index?.entries ?? {};
  const protectedEntry = (hash, e) =>
    hash === keepHash || live.has(hash) || e.server === "production" || isBuiltin(hash)
    || (Array.isArray(e.seenOn) && e.seenOn.some((r) => r?.server === "production"));
  const staging = Object.entries(entries)
    .filter(([h, e]) => e?.status === "ok" && e.server === "staging" && HASH_RE.test(h))
    .sort(([ha, a], [hb, b]) => time(b) - time(a) || (ha < hb ? 1 : ha > hb ? -1 : 0));
  // keepHash counts as newest whatever its date says.
  const ranked = [...staging.filter(([h]) => h === keepHash), ...staging.filter(([h]) => h !== keepHash)];
  const adapters = ranked.slice(keep).filter(([h, e]) => !protectedEntry(h, e)).map(([h]) => h).sort();
  const placeholders = Object.entries(entries)
    .filter(([h, e]) => e?.status === "needs-attention" && e.server === "staging" && h !== keepHash)
    .map(([h]) => h).sort();
  return { adapters, placeholders };
}
