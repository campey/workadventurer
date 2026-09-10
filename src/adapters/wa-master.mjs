// Rolling-master adapter for play.staging.workadventu.re. Spreads the frozen
// wa-1.33 baseline and overrides only what has drifted. Stability "tracking":
// a failing `selfcheck --target wa-master` is a known-issues note, not a merge
// blocker. Refresh trackedSha / apiVersionHashes / proto via scripts/vendor-proto.mjs.

import wa133 from "./wa-1.33.mjs";

export default {
  ...wa133,
  id: "wa-master",
  waVersion: "master",
  stability: "tracking",
  trackedSha: "7d628838",
  verifiedDate: "2026-09-10",
  verified: {
    ok: ["join", "move", "bubble", "emote"],
    broken: ["proximity audio — red mic / #10 mic-state race"],
  },
  // Recomputed at trackedSha (see README § apiVersionHash). Stale once the
  // staging sha moves — resolveAdapter warns when it detects drift.
  apiVersionHashes: ["907396a8"],
  protoPath: "proto/wa-master/messages.proto",
  // Behavioural overrides go here as they are discovered — none needed yet.
};
