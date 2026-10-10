// Which voice signalling does a pair of avatars see? A and B stand in proximity
// (expect WEBRTC peer signalling between them, per docs/livekit.md: escalation to
// LiveKit follows mesh size, not area type). The area-meeting half needs a confirmed
// meeting area in the world facts; none exist yet, so it is recorded as skipped.
import { readFileSync } from "node:fs";
import { waitFor } from "../port.mjs";

export default {
  question: "What signalling does a proximity pair see: WEBRTC between them, or a LiveKit invitation?",
  world: "afrolabs open space",
  async run(ctx) {
    const facts = JSON.parse(readFileSync(ctx.world.factsFile, "utf8"));
    const meetingAreas = (facts.meetingAreas ?? []).filter((m) => m.confirmedBy);
    const signals = { A: [], B: [] };
    const joined = { A: false, B: false };

    const b = ctx.avatar("B");
    const a = ctx.avatar("A");
    for (const [role, w] of [["A", a], ["B", b]]) {
      await w.enableVoice();
      w.on("voiceSignal", (s) => signals[role].push(s));
      w.on("meetingJoined", () => { joined[role] = true; });
    }
    await b.connect();
    await a.connect();
    ctx.log("A and B joined");

    // Stand A one tile from B and wait for the proximity meeting to form.
    const pos = b.self();
    const metA = waitFor(a, "meetingJoined", () => true, 20000);
    const metB = waitFor(b, "meetingJoined", () => true, 20000);
    await a.moveTo(pos.x + 32, pos.y);
    await Promise.all([metA, metB]).catch(() => {});
    if (!joined.A || !joined.B) {
      throw new Error(`inconclusive: no proximity meeting formed (A joined=${joined.A}, B joined=${joined.B})`);
    }
    // Give signalling a moment to arrive after the meeting forms.
    await Promise.race([
      waitFor(a, "voiceSignal", () => true, 15000).catch(() => null),
      waitFor(b, "voiceSignal", () => true, 15000).catch(() => null),
    ]);
    await new Promise((r) => setTimeout(r, 3000));

    const kinds = (arr) => [...new Set(arr.map((s) => s.kind))];
    const observed = {
      proximity: { aSaw: signals.A, bSaw: signals.B },
      areaMeeting: meetingAreas.length
        ? "not implemented: confirmed meeting areas exist but this probe does not yet drive into one"
        : "skipped: no confirmed meeting area in the world facts",
    };
    const all = [...kinds(signals.A), ...kinds(signals.B)];
    if (!all.length) {
      throw new Error("inconclusive: meeting formed but no voice signalling was seen by either avatar");
    }
    if (all.includes("livekit")) {
      return { observed, verdict: "contradicts", note: "a LiveKit invitation arrived for a two-avatar proximity meeting; docs/livekit.md says escalation follows mesh size" };
    }
    return {
      observed,
      verdict: "confirms",
      note: "a proximity pair saw WEBRTC signalling and no LiveKit invitation (area-meeting half not exercised)",
    };
  },
};
