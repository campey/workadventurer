// What does the real browser client tell the server when it walks into a meeting
// area? A person walks their browser avatar into a meeting area (e.g. the
// afrolabs firepit) and back out while our avatar watches the details the
// server relays about them (playerDetailsUpdatedMessage, availabilityStatus).
// Starts with the 👍 handshake (human-check.mjs); the person who 👍s is the one
// watched.
//   node world-port/probes/run.mjs meeting-availability --world "afrolabs open space"
import { askHuman } from "./human-check.mjs";

const STATUS = { 0: "UNCHANGED", 1: "ONLINE", 2: "SILENT", 3: "AWAY", 4: "JITSI", 5: "BBB",
  6: "DENY_PROXIMITY_MEETING", 7: "SPEAKER", 8: "BUSY", 9: "DO_NOT_DISTURB", 10: "BACK_IN_A_MOMENT", 11: "LIVEKIT" };
const statusName = (v) => (typeof v === "string" ? v : STATUS[v] ?? String(v));

export default {
  question: "What availability status does a browser client send when it walks into a meeting area?",
  world: "afrolabs open space",
  async run(ctx) {
    const a = ctx.avatar("A");
    const c = a.client;
    const t0 = Date.now();
    const seen = []; // every relayed detail/position for the watched person, in order

    // Tap the raw room events: the client doesn't surface playerDetailsUpdatedMessage.
    const handleSub = c._handleSub.bind(c);
    let watched = null; // the userId of the person who 👍s
    const joinedStatus = new Map(); // userId -> availabilityStatus at join
    c._handleSub = (sub) => {
      const j = sub.userJoinedMessage;
      if (j) joinedStatus.set(j.userId, j.availabilityStatus);
      const d = sub.playerDetailsUpdatedMessage;
      if (d && (watched == null || d.userId === watched)) {
        const s = d.details?.availabilityStatus;
        seen.push({ t: Date.now() - t0, userId: d.userId, kind: "details", availabilityStatus: s == null ? null : statusName(s), details: d.details });
        ctx.log(`  details for user ${d.userId}: ${s == null ? JSON.stringify(d.details) : statusName(s)}`);
      }
      return handleSub(sub);
    };
    await a.connect();

    const meetingAreas = (c.areas ?? []).filter((ar) => (ar.rawProps ?? []).some((p) => p.type === "livekitRoomProperty"));
    const isMeeting = (ar) => meetingAreas.includes(ar);
    // Any .wam area counts for tracking; the timeline marks which are meeting areas.
    const areaAt = (x, y) => {
      const ar = (c.areas ?? []).find((z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h);
      return ar ? `${ar.name}${isMeeting(ar) ? " [meeting]" : ""}` : null;
    };

    // Handshake; remember who answered.
    let answerer = null;
    const grab = (e) => { if (!(e.name ?? "").startsWith("wa-probe-") && /👍/.test(e.emote)) answerer = e; };
    a.on("emote", grab);
    const start = await askHuman(a, "👍 when you can see me, 😂 to cancel", { log: ctx.log });
    a.off("emote", grab);
    if (start !== "good" || !answerer) throw new Error(`inconclusive: not started (${start})`);
    watched = answerer.userId;
    const initial = c.players.get(watched);
    ctx.log(`watching ${answerer.name} (user ${watched}); initial availability ${statusName(joinedStatus.get(watched) ?? "?")}`);

    // Track their meeting-area membership from relayed positions.
    let lastArea = areaAt(initial?.x ?? -1, initial?.y ?? -1);
    seen.push({ t: Date.now() - t0, kind: "area", area: lastArea });
    const onMove = (p) => {
      if (p?.userId !== watched) return;
      const ar = areaAt(p.x, p.y);
      if (ar !== lastArea) { lastArea = ar; seen.push({ t: Date.now() - t0, kind: "area", area: ar }); ctx.log(`  ${answerer.name} ${ar ? `entered "${ar}"` : "is outside any area"}`); }
    };
    c.on("playerMoved", onMove);

    const done = await askHuman(a, "walk into the firepit, stay ~10s, walk out, then 👍", { timeoutMs: 300000, log: ctx.log });
    c.off("playerMoved", onMove);
    a.speechBubble("thanks!");

    const details = seen.filter((s) => s.kind === "details");
    const entered = seen.some((s) => s.kind === "area" && s.area?.endsWith("[meeting]"));
    if (done !== "good" || !entered) throw new Error(`inconclusive: ${done !== "good" ? `walk not confirmed (${done})` : "never saw them inside a meeting area"}`);
    return {
      observed: { watched: answerer.name, meetingAreas: meetingAreas.map((m) => m.name), timeline: seen },
      verdict: "new",
      note: details.length
        ? "the browser client changed its details while in the meeting area: see the timeline for the availabilityStatus it sent"
        : "no player-details update was relayed while they walked through the meeting area",
    };
  },
};
