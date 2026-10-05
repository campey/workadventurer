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
// server. Everything under `unexercised` is inherited from 1.33 on faith.

import wa133 from "./wa-1.33.mjs";

export default {
  ...wa133,
  id: "wa-1.34",
  waVersion: "1.34",
  stability: "frozen",
  releaseTag: "v1.34.0",
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
    ],
    unexercised: [
      "meeting invitations (invite-over accept + walk)",
      "sendChatMessage",
      "greet / thought-bubble",
    ],
  },
  // A SET: a patch release can shift the hash with no behaviour change — append
  // here (computed by scripts/vendor-proto.mjs), never fork a new adapter file.
  apiVersionHashes: ["23c8eb8c"], // v1.34.0
  protoPath: "proto/wa-1.34/messages.proto",
};
