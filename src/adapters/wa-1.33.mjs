// Baseline adapter: WorkAdventure prod (play.workadventu.re, build v1.33.5).
// Every value here is what src/wa-client.mjs / src/wa-audio.mjs used inline
// before the version-adapter seam. FROZEN — do not change for staging/master
// work; see docs/superpowers/specs/2026-09-10-wa-version-adapters-design.md.

import { shortHash, slugify } from "./wa-helpers.mjs";

export default {
  id: "wa-1.33",
  waVersion: "1.33",
  stability: "frozen",

  // --- mechanical ---
  // A SET of accepted apiVersionHash values: a patch release can shift the hash
  // with no behaviour change — append here, never fork a new adapter file.
  apiVersionHashes: ["bfd20fc4"],
  protoPath: "proto/wa-1.33/messages.proto",
  defaultWokaId: "506a3a64-47a9-4587-b19b-2d1eb13f9790",
  endpoints: { anonymLogin: "/anonymLogin", map: "/map", wokaList: "/woka/list" },
  wokaListAuthHeader: (token) => ({ Authorization: token }), // bare token, no "Bearer"
  envelope: "seq-len-v1",

  // --- behaviours ---
  spaceJoin: {
    filterType: 0, // ALL_USERS
    defaultPropsToSync: ["cameraState", "microphoneState", "screenSharingState"],
    watchViaAddSpaceFilter: true,
    micReannounceMs: [0, 1000, 3000], // #10 mitigation: re-announce mic-on
  },
  areaMeetingSpaceName: (roomUrl, prop) =>
    slugify(
      shortHash(roomUrl) + "-" + (prop.roomName?.trim() ? prop.roomName : prop.id)
    ),
  emote: { wireFormat: "emoji-string", channel: "sub.emoteEventMessage" },
  micState: {
    updateMaskPaths: ["microphoneState"],
    speakingMaskPaths: ["showVoiceIndicator", "microphoneState"],
  },
  meeting: { webrtcStrategyName: "WEBRTC" },
};
