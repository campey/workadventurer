// Re-tests the spawn note: an avatar appears in the `.wam` start area, not at
// the Tiled `start` layer. B joins first; A joins; B reports where it saw A.
import { waitFor } from "../port.mjs";

export default {
  question: "Where does an avatar appear: the .wam start area or the Tiled start layer?",
  world: "afrolabs open space",
  async run(ctx) {
    const b = ctx.avatar("B");
    await b.connect();
    ctx.log("B joined");
    const a = ctx.avatar("A");
    // Register before A connects so the join event cannot be missed.
    const seen = waitFor(b, "playerJoined", (p) => p.name === "wa-probe-a", 20000);
    await a.connect();
    ctx.log("A joined");
    const aAsSeen = await seen;

    const starts = (a.client.areas ?? [])
      .filter((ar) => (ar.rawProps ?? []).some((p) => p.type === "start"))
      .map((ar) => ({
        name: ar.name,
        x: ar.x, y: ar.y, w: ar.w, h: ar.h,
        isDefault: (ar.rawProps ?? []).some((p) => p.type === "start" && p.isDefault) || false,
      }));
    const inside = (r) => aAsSeen.x >= r.x && aAsSeen.x <= r.x + r.w && aAsSeen.y >= r.y && aAsSeen.y <= r.y + r.h;
    const insideAny = starts.some(inside);
    const observed = { startAreas: starts, aAsSeenByB: { x: aAsSeen.x, y: aAsSeen.y }, insideStartArea: insideAny };
    if (!starts.length) {
      return { observed, verdict: "new", note: "this world has no .wam start area; nothing to compare against" };
    }
    return {
      observed,
      verdict: insideAny ? "confirms" : "contradicts",
      note: insideAny
        ? "A appeared inside a .wam start area"
        : "A appeared outside every .wam start area; check against the Tiled start layer and correct the note",
    };
  },
};
