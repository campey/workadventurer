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
    // `node scripts/selfcheck.mjs --target wa-master --room <staging>` with
    // WA_PUSHER_URL=https://pusher.staging.workadventu.re and a staging woka id
    // (WA_WOKA_ID=62b0c71f-f396-432b-a4c8-4d369d73e766 "Leo").
    ok: ["join", "move", "bubble", "area-meeting join"],
    broken: ["proximity audio — red mic / #10 mic-state race (not re-tested)"],
  },
  // Computed by scripts/vendor-proto.mjs at trackedSha. Stale once the staging
  // master sha moves — resolveAdapter warns when it detects drift.
  apiVersionHashes: ["3fb30729"],
  protoPath: "proto/wa-master/messages.proto",
  // Behavioural overrides go here as they are discovered — none needed yet.
};
