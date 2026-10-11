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
  assert.deepEqual(r.ours[0], { lap: 1, spaceJoinMs: 100, strategy: null, signalMs: null, signal: null, invitationMs: 300, iceMs: {}, connectedMs: 3300, transport: "connected+publishing", errors: [], bSawParticipantMs: 2800, bSawTrackMs: 3600 });
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

test("peer-to-peer laps: signalling, ICE stages and the p2p connect are timed from entry", () => {
  const ev = [
    { t: 0, kind: "lap", lap: 1, what: "start" },
    { t: 1000, kind: "own", who: "A", what: "entered the area" },
    { t: 1150, kind: "lkOwn", who: "A", what: "signal webrtc" },
    { t: 1200, kind: "lkOwn", who: "A", what: "ice checking" },
    { t: 4200, kind: "lkOwn", who: "A", what: "ice connected" },
    { t: 4600, kind: "lkOwn", who: "A", what: "p2p connected" },
    { t: 4700, kind: "lkOwn", who: "A", what: "error", detail: "stun timeout" },
  ];
  const r = analyseVoice(ev).ours[0];
  assert.equal(r.signal, "signal webrtc"); assert.equal(r.signalMs, 150);
  assert.deepEqual(r.iceMs, { "ice checking": 200, "ice connected": 3200 });
  assert.equal(r.transport, "p2p connected"); assert.equal(r.connectedMs, 3600);
  assert.deepEqual(r.errors, ["stun timeout"]);
});
