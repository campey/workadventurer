// Baseline adapter: WorkAdventure prod (play.workadventu.re, build v1.33.8 as
// of this pin). Every value here is what src/wa-client.mjs / src/wa-audio.mjs
// used inline before the version-adapter seam. FROZEN — do not change for
// staging/master work; see
// docs/superpowers/specs/2026-09-10-wa-version-adapters-design.md.

import { shortHash, slugify } from "./wa-helpers.mjs";

export default {
  id: "wa-1.33",
  waVersion: "1.33",
  stability: "frozen",

  // --- mechanical ---
  // A SET of accepted apiVersionHash values: a patch release can shift the hash
  // with no behaviour change — append here, never fork a new adapter file.
  // Index 0 is what wa-client.mjs actually sends; newest first.
  // 23c8eb8c (v1.34.0) is a STOPGAP, issue #55: prod moved to v1.34.0 and
  // hard-rejects the 1.33 hashes (errorScreen NEW_VERSION). Computed with
  // `node scripts/vendor-proto.mjs --check v1.34.0` and verified to connect,
  // but every behaviour below is still 1.33's and nobody has diffed 1.34's
  // proto against proto/wa-1.33/ — a real wa-1.34 adapter is the follow-up.
  apiVersionHashes: ["23c8eb8c", "05489a87", "bfd20fc4"], // v1.34.0 (stopgap), v1.33.8, v1.33.5
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
  meeting: { webrtcStrategyName: "WEBRTC", livekitStrategyName: "LIVEKIT" },
};
