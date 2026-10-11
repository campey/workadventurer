// analyseVoice(): our avatar's lap timings and each human's audio-join timings, from made-up events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseVoice } from "../world-port/probes/observe-humans.mjs";

test("our lap: enter -> space join -> invitation -> connected, and B's view of A", () => {
  const ev = [
    { t: 1000, kind: "lap", lap: 1, what: "start" },
    { t: 2000, kind: "own", who: "A", what: "entered the area" },
    { t: 2100, kind: "own", who: "A", what: "joined space", spaceName: "9ida9r-fire-pit" },
    { t: 2300, kind: "lkOwn", who: "A", what: "invitation" },
    { t: 5300, kind: "lkOwn", who: "A", what: "connected+publishing" },
    { t: 4800, kind: "lkRoom", what: "participantConnected", name: "wa-probe-a" },
    { t: 5600, kind: "lkRoom", what: "trackPublished", name: "wa-probe-a" },
    { t: 9000, kind: "lap", lap: 2, what: "start" },
    { t: 9500, kind: "own", who: "A", what: "joined space", spaceName: "9ida9r-fire-pit" }, // never entered: no area event
  ];
  const r = analyseVoice(ev);
  assert.deepEqual(r.ours[0], { lap: 1, spaceJoinMs: 100, invitationMs: 300, connectedMs: 3300, bSawParticipantMs: 2800, bSawTrackMs: 3600 });
  assert.equal(r.ours[1].note, "never entered");
});

test("a human's audio join is measured from their space join as seen by B", () => {
  const ev = [
    { t: 5000, kind: "spaceAdd", by: "B", spaceName: "9ida9r-fire-pit", name: "Human" },
    { t: 5400, kind: "lkRoom", what: "participantConnected", name: "Human" },
    { t: 6100, kind: "lkRoom", what: "trackPublished", name: "Human" },
    { t: 5000, kind: "spaceAdd", by: "B", spaceName: "9ida9r-fire-pit", name: "wa-probe-a" }, // ours: ignored here
    { t: 7000, kind: "spaceAdd", by: "B", spaceName: "9ida9r-fire-pit", name: "Late" }, // no room events: nulls
  ];
  const r = analyseVoice(ev);
  assert.deepEqual(r.humans.Human, [{ spaceJoinT: 5000, participantMs: 400, trackMs: 1100 }]);
  assert.deepEqual(r.humans.Late, [{ spaceJoinT: 7000, participantMs: null, trackMs: null }]);
  assert.equal(r.humans["wa-probe-a"], undefined);
});
