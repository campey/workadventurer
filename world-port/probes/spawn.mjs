// Re-tests the spawn note: an avatar appears in the `.wam` start area, not at
// the Tiled `start` layer. B joins first; A joins; B reports where it saw A.
import { waitFor } from "../port.mjs";

export default {
  question: "Where does an avatar appear: the .wam start area or the Tiled start layer?",
  world: "afrolabs open space",
  async run(ctx) {
    const b = ctx.avatar("B");
    await b.connect();
    const a = ctx.avatar("A");
    // _loadAreas() is best-effort; its "loaded N map areas" log is the proof the map arrived.
    let areasLoaded = false, areasFailure = null;
    a.client.on("log", (m) => {
      if (/^loaded \d+ map areas/.test(m)) areasLoaded = true;
      else if (/^map areas unavailable/.test(m)) areasFailure = m;
    });
    ctx.log("B joined");
    // Register before A connects so the join event cannot be missed.
    const seen = waitFor(b, "playerJoined", (p) => p.name === "wa-probe-a", 20000);
    await a.connect();
    ctx.log("A joined");
    const aAsSeen = await seen;
    if (!areasLoaded) {
      throw new Error(`inconclusive: map areas did not load (${areasFailure ?? "no .wam for this room"})`);
    }

    const starts = (a.client.areas ?? [])
      .filter((ar) => (ar.rawProps ?? []).some((p) => p.type === "start"))
      .map((ar) => ({
        name: ar.name,
        x: ar.x, y: ar.y, w: ar.w, h: ar.h,
        isDefault: (ar.rawProps ?? []).some((p) => p.type === "start" && p.isDefault) || false,
      }));
    // The client may nudge the spawn to the nearest free tile centre, which can sit
    // just outside the rectangle, so containment allows one tile (32px) of slack.
    const TILE = 32;
    const inside = (r) =>
      aAsSeen.x >= r.x - TILE && aAsSeen.x <= r.x + r.w + TILE &&
      aAsSeen.y >= r.y - TILE && aAsSeen.y <= r.y + r.h + TILE;
    const insideAny = starts.some(inside);
    const observed = { startAreas: starts, aAsSeenByB: { x: aAsSeen.x, y: aAsSeen.y }, insideStartArea: insideAny,
      tiledStartLayerSample: a.client.nav?.randomSpawnPx?.() ?? null };
    if (!starts.length) {
      return { observed, verdict: "new", note: "this world has no .wam start area; nothing to compare against" };
    }
    return {
      observed,
      verdict: insideAny ? "confirms" : "contradicts",
      note: insideAny
        ? "A appeared inside a .wam start area (expanded by one tile, 32px, for the nudge to a free tile)"
        : "A appeared outside every .wam start area even with one tile (32px) of slack; check against the Tiled start layer and correct the note",
    };
  },
};
