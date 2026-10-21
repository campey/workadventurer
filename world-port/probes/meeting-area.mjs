// Which map areas are meeting areas, and does walking into one join its space?
// Reads the client's areas for a `livekitRoomProperty`, walks A to the centre of the first one
// (the rule scripts/selfcheck.mjs uses, or the one named by `--at "<name>"`) and reports the rectangle and the space A joined.
import { waitFor } from "../port.mjs";

export default {
  question: "Which area is a meeting area (livekitRoomProperty), where is it, and which space does walking in join?",
  world: "afrolabs open space",
  async run(ctx) {
    const a = ctx.avatar("A");
    let areasLoaded = false, areasFailure = null;
    a.client.on("log", (m) => {
      if (/^loaded \d+ map areas/.test(m)) areasLoaded = true;
      else if (/^map areas unavailable/.test(m)) areasFailure = m;
    });
    await a.connect();
    ctx.log("A joined");
    if (!areasLoaded) throw new Error(`inconclusive: map areas did not load (${areasFailure ?? "no .wam for this room"})`);

    const meeting = (a.client.areas ?? [])
      .filter((ar) => (ar.rawProps ?? []).some((p) => p.type === "livekitRoomProperty"))
      .map((ar) => ({ name: ar.name, x: ar.x, y: ar.y, w: ar.w, h: ar.h }));
    if (!meeting.length) {
      return { observed: { meetingAreas: [] }, verdict: "new", note: "this world has no livekitRoomProperty area; nothing to confirm" };
    }
    // `--at "<area name>"` picks the area to walk into; the default is the first, as selfcheck does.
    const want = ctx.args?.at?.[0];
    const target = want ? meeting.find((m) => m.name === want) : meeting[0];
    if (!target) throw new Error(`inconclusive: no meeting area named "${want}"`);
    const joined = waitFor(a, "meetingJoined", () => true, 15000);
    await a.moveTo(target.x + target.w / 2, target.y + target.h / 2);
    ctx.log(`A moved to the centre of "${target.name}"`);
    const m = await joined.catch(() => null);
    const observed = { meetingAreas: meeting, walkedInto: target, joinedSpace: m?.spaceName ?? null };
    if (!m) throw new Error(`inconclusive: no meetingJoined within 15 s of entering "${target.name}"`);
    return { observed, verdict: "confirms", note: `walking into "${target.name}" joined space ${m.spaceName}` };
  },
};
