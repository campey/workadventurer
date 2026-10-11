// Prod adapter for WorkAdventure v1.34.x (play.workadventu.re moved to v1.34.0
// on or before 2026-10-05 and hard-rejected the 1.33 hashes — issue #55).
// Spreads the frozen wa-1.33 baseline and overrides only what differs: the
// version hash and the proto the client encodes/decodes with.
//
// What changed 1.33.8 -> 1.34.0 on the wire (reproduce with
// `node scripts/proto-diff.mjs proto/wa-1.33/messages.proto proto/wa-1.34/messages.proto`):
// no field renumbered, retyped or renamed; 51 additive changes; the only
// removals are the recording start/stop queries, userMessageRead and the
// admin/ban messages — none referenced by this client.
//
// What a proto diff can NOT show is a behaviour change behind an unchanged
// shape, so `verified` records what was actually exercised against the live
// server. Anything listed under `unexercised` is inherited from 1.33 on faith.
// It is empty because the four items #70 had to inherit (issue #71) have since
// been run live — that is NOT an audit of every CLI command (`wa quiet`,
// `wa wait-emote`, … were not separately exercised).

import wa133 from "./wa-1.33.mjs";

export default {
  ...wa133,
  id: "wa-1.34",
  waVersion: "1.34",
  stability: "frozen",
  releaseTag: "v1.34.1",
  verifiedDate: "2026-10-05",
  verified: {
    // Live against play.workadventu.re (several daemons over a few hours, incl.
    // a 5-avatar bench in a LiveKit-escalated meeting).
    ok: [
      "connect + join (anonymLogin, map, areas)",
      "move / walk / follow",
      "space join + leave, area meetings (debounced)",
      "proximity WEBRTC peers (P2P) + LiveKit invitation/publish/subscribe",
      "emote events",
      "wa sound over both transports",
      "STT over both transports, late joiners named",
      "speech bubble set + clear, area-meeting join (`wa selfcheck --target production` resolved wa-1.34 and passed)",
      // 2026-10-05, two headless avatars + a human (issue #71):
      "sendChatMessage both ways — exact text and sender name on the receiver, ~1s",
      "wa greet — walks to within ~26px, ends facing the target, joins the shared space",
      "thought-bubble / speech-bubble / clear — server accepts, connection healthy, and a human saw both render",
      "meeting invitation (invite-over) — a human invited the avatar; it accepted and walked over (`arrived: true`)",
    ],
    unexercised: [],
  },
  // A SET: a patch release can shift the hash with no behaviour change — append
  // here (computed by scripts/vendor-proto.mjs), never fork a new adapter file.
  // Probe `meeting-availability` (2026-10-10, live, a browser client): entering a
  // `livekitRoomProperty` meeting area makes the browser send
  // `setPlayerDetailsMessage { availabilityStatus: LIVEKIT (11) }`, and leaving sends
  // ONLINE (1). Probe `firepit-meeting` confirmed a person sees the right thing when we
  // do the same. Not in the frozen wa-1.33 baseline.
  //
  // No dwell, no linger: probe `observe-humans` (2026-10-11, two real browser players, 12 min) saw the
  // browser flip LIVEKIT and join the meeting space at the same instant it enters the area (118-336 ms
  // before the first relayed position inside; 6/6), and flip ONLINE within 0-183 ms of the first position
  // outside, space leave first or together; the status flips even on a graze. wa-1.33 keeps 1500 / 2500.
  meeting: { ...wa133.meeting, areaAvailabilityStatus: 11, areaDwellMs: 0, areaLingerMs: 0 },
  // observe-humans 2026-10-11: walking median 181 px/s (steady laps 173-183), running (shift) about
  // 420-520 px/s (12 windows from one stretch: low confidence, median about 460). Speed is client-side;
  // the server doesn't enforce it. Used by walkTo/navTo `pace: "walk" | "run"` (step = speed * 100 ms).
  movement: { walkPxPerS: 180, runPxPerS: 460 },
  // v1.34.1 (prod from 2026-10-11) first, then v1.34.0. messages.proto is byte-identical between them; only
  // libs/messages JsonMessages (analytics) changed, which moves the hash but not the wire.
  apiVersionHashes: ["b82fc568", "23c8eb8c"],
  protoPath: "proto/wa-1.34/messages.proto",
};
