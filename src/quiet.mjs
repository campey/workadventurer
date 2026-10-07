// `wa quiet` (issue #81): step away to the nearest empty area, or stay put if
// already in one. Standalone — it no longer pauses a follow (there is none).

export const QUIET_EXCLUDE = /board\s*room|podium|audience/i;

/** @returns {{ok:true, quietSpot:string|null, alreadyQuiet?:true}} */
export async function goQuiet(wa, { log = () => {} } = {}) {
  const players = wa.listPlayers();
  const here = wa.nav?.areaAt(wa.pos.x, wa.pos.y);
  if (
    here &&
    !QUIET_EXCLUDE.test(here.name) &&
    players.every((pl) => !wa.nav._rectContains(here, pl.x, pl.y, 48))
  ) {
    return { ok: true, quietSpot: here.name, alreadyQuiet: true };
  }
  const area = wa.nav?.nearestEmptyArea(wa.pos.x, wa.pos.y, players, { excludeRe: QUIET_EXCLUDE });
  if (!area) return { ok: true, quietSpot: null };
  // Fire and forget: the HTTP call answers at once and the walk continues.
  wa.navTo(area.x, area.y, { stopWithin: 64, timeoutMs: 60_000 }).then((r) =>
    log(`quiet -> "${area.name}"`, JSON.stringify(r))
  );
  return { ok: true, quietSpot: area.name };
}
