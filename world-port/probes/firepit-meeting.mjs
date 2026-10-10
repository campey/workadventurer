// A browser player and our avatar share a meeting area (the afrolabs "Fire Pit"),
// with our avatar behaving like the browser client: availabilityStatus LIVEKIT
// on entering a meeting area, ONLINE on leaving (see meeting-availability).
// The person drives the sequence by emote (human-check.mjs):
//   1. person walks in   2. we walk in   3. person leaves   4. person returns
//   5. we leave
// At each step the person answers 👍/😂 to "does it look right?", and we
// record what our client saw: its own space joins/leaves and proximity bubble
// events, plus the person's relayed availability and area.
//   node world-port/probes/run.mjs firepit-meeting --world "afrolabs open space"
import { askHuman } from "./human-check.mjs";

const LIVEKIT = 11, ONLINE = 1;
const STATUS = { 1: "ONLINE", 3: "AWAY", 11: "LIVEKIT" };

export default {
  question: "With our avatar sending LIVEKIT like a browser does, do a person and our avatar share the Fire Pit meeting with no proximity bubble, through people coming and going?",
  world: "afrolabs open space",
  async run(ctx) {
    const a = ctx.avatar("A");
    const c = a.client;
    const t0 = Date.now();
    const timeline = [];
    const note = (kind, data = {}) => {
      timeline.push({ t: Date.now() - t0, kind, ...data });
      ctx.log(`  ${kind} ${JSON.stringify(data)}`);
    };

    let watched = null;
    const handleSub = c._handleSub.bind(c);
    c._handleSub = (sub) => {
      const d = sub.playerDetailsUpdatedMessage;
      if (d && d.userId === watched && d.details?.availabilityStatus != null)
        note("their status", { status: STATUS[d.details.availabilityStatus] ?? d.details.availabilityStatus });
      return handleSub(sub);
    };
    c.on("spaceJoined", ({ spaceName }) => note("we joined space", { spaceName }));
    c.on("spaceLeft", ({ spaceName }) => note("we left space", { spaceName }));
    c.on("bubbleEntered", ({ groupId }) => note("we entered a proximity bubble", { groupId }));
    c.on("bubbleLeft", () => note("we left the proximity bubble"));

    await a.connect();
    const pit = (c.areas ?? []).find((z) => /fire\s*pit/i.test(z.name));
    if (!pit) throw new Error("inconclusive: no Fire Pit area in this world");
    const inPit = (x, y) => x >= pit.x && x <= pit.x + pit.w && y >= pit.y && y <= pit.y + pit.h;
    const home = { x: c.pos.x, y: c.pos.y };
    const setStatus = (s) => { c._send({ setPlayerDetailsMessage: { availabilityStatus: s } }); note("we sent status", { status: STATUS[s] }); };
    const ask = (prompt, timeoutMs) => askHuman(a, prompt, { log: ctx.log, timeoutMs });
    const answers = [];
    const step = async (label, prompt) => {
      const v = await ask(prompt);
      answers.push({ step: label, answer: v });
      note("answer", { step: label, answer: v });
      return v;
    };

    // Handshake; remember who answered.
    let answerer = null;
    const grab = (e) => { if (!(e.name ?? "").startsWith("wa-probe-") && /👍/.test(e.emote)) answerer = e; };
    a.on("emote", grab);
    const start = await ask("firepit test: 👍 when you can see me, 😂 to cancel");
    a.off("emote", grab);
    if (start !== "good" || !answerer) throw new Error(`inconclusive: not started (${start})`);
    watched = answerer.userId;
    c.on("playerMoved", (p) => {
      if (p?.userId !== watched) return;
      const now = inPit(p.x, p.y);
      if (now !== c._probeTheyInPit) { c._probeTheyInPit = now; note(now ? "they entered the Fire Pit" : "they left the Fire Pit"); }
    });

    await step("1 they walk in", "1/5: walk into the Fire Pit, then 👍");

    // The pit's centre is the fire (solid): aim for the nearest open tile inside the area.
    let [tx, ty] = [pit.x + pit.w / 2, pit.y + pit.h / 2];
    const free = c.nav?.nearestFree(...c.nav.pxToTile(tx, ty));
    if (free) [tx, ty] = c.nav.tileCenterPx(free[0], free[1]);
    await c.navTo(tx, ty, { stopWithin: 16, timeoutMs: 45000 });
    setStatus(LIVEKIT);
    note("we are in the Fire Pit", { at: [c.pos.x | 0, c.pos.y | 0] });
    await new Promise((r) => setTimeout(r, 4000)); // past the 1.5 s dwell
    await step("2 we walk in", "2/5: I'm in the Fire Pit with you. Same meeting, no bubble?");

    await step("3 they leave", "3/5: please leave the Fire Pit, then 👍 if it looks right (I stay in the meeting, no bubble to you)");

    await step("4 they return", "4/5: come back into the Fire Pit, then 👍 if we're together again with no bubble");

    await c.navTo(home.x, home.y, { stopWithin: 16, timeoutMs: 45000 });
    setStatus(ONLINE);
    note("we left the Fire Pit", { at: [c.pos.x | 0, c.pos.y | 0] });
    await new Promise((r) => setTimeout(r, 4000)); // past the 2.5 s linger
    await step("5 we leave", "5/5: I left. Did I leave the meeting cleanly, with no bubble to you?");
    a.speechBubble("firepit test done, thanks!");

    const wrong = answers.filter((x) => x.answer === "wrong");
    const unanswered = answers.filter((x) => x.answer === "no answer");
    if (unanswered.length === answers.length) throw new Error("inconclusive: no step was answered");
    return {
      observed: { area: { name: pit.name, x: pit.x, y: pit.y, w: pit.w, h: pit.h }, answers, timeline },
      verdict: "new",
      note: wrong.length ? `${wrong.length} step(s) answered 😂: ${wrong.map((x) => x.step).join(", ")}` : `all ${answers.length - unanswered.length} answered steps looked right`,
    };
  },
};
