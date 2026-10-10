// Walking *through* a livekitRoomProperty area must not spin a meeting space
// up and back down — that churn OOMs the daemon and floods peers. Only a real
// dwell joins; a brief exit lingers before tearing down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkAdventureClient } from "../src/wa-client.mjs";

function harness({ meeting } = {}) {
  const c = new WorkAdventureClient({
    adapter: {
      envelope: "seq-len-v1",
      areaMeetingSpaceName: (_u, p) => `space-${p.id}`,
      ...(meeting ? { meeting } : {}),
    },
  });
  const sent = [];
  c._send = (m) => { if (m.setPlayerDetailsMessage) sent.push(m); }; // only availability matters here
  const joins = [];
  const leaves = [];
  c._joinSpace = async (s) => {
    joins.push(s);
    c.spaces.set(s, { spaceUserId: "x" });
  };
  // The real _leaveSpace (it owns the availability bookkeeping) with the wire stubbed out.
  const realLeave = WorkAdventureClient.prototype._leaveSpace;
  c.query = async () => ({});
  c._leaveSpace = (s) => {
    leaves.push(s);
    return realLeave.call(c, s);
  };
  const area = {
    id: "A1",
    name: "Meeting",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rawProps: [{ type: "livekitRoomProperty", id: "m1" }],
  };
  const enter = () => {
    c.currentAreas = new Set(["A1"]);
    c._handleAreaMeeting(area, true);
  };
  const leave = () => {
    c.currentAreas = new Set();
    c._handleAreaMeeting(area, false);
  };
  return { c, joins, leaves, sent, enter, leave };
}

test("walking through a meeting area does not join or leave anything", async () => {
  const { joins, leaves, enter, leave } = harness();
  enter();
  await sleep(400); // < DWELL_MS
  leave();
  await sleep(2000);
  assert.deepEqual(joins, []);
  assert.deepEqual(leaves, []);
});

test("dwelling in a meeting area joins after the dwell window", async () => {
  const { joins, enter } = harness();
  enter();
  await sleep(600);
  assert.deepEqual(joins, [], "not yet");
  await sleep(1200); // past DWELL_MS total
  assert.deepEqual(joins, ["space-m1"]);
});

test("a brief exit does not tear the meeting down; a sustained one does", async () => {
  const { c, joins, leaves, enter, leave } = harness();
  enter();
  await sleep(1800); // join
  assert.deepEqual(joins, ["space-m1"]);

  leave();
  await sleep(800); // < LINGER_MS
  c.currentAreas = new Set(["A1"]); // walked back in
  c._handleAreaMeeting({ id: "A1", name: "Meeting", rawProps: [{ type: "livekitRoomProperty", id: "m1" }] }, true);
  await sleep(2500);
  assert.deepEqual(leaves, [], "brief exit + return keeps the space");

  leave();
  await sleep(3000); // past LINGER_MS, stayed out
  assert.deepEqual(leaves, ["space-m1"]);
});

test("rapid enter/leave flapping causes at most one join", async () => {
  const { joins, leaves, enter, leave } = harness();
  for (let i = 0; i < 6; i++) {
    enter();
    await sleep(120);
    leave();
    await sleep(120);
  }
  await sleep(2000);
  assert.equal(joins.length, 0, "never dwelled long enough to join");
  assert.equal(leaves.length, 0);
});

// A browser sends availabilityStatus LIVEKIT (11) when it walks into a meeting area and ONLINE (1)
// when it leaves (probe meeting-availability, 2026-10-10). We do the same, only when the adapter
// defines the value (wa-1.34), and only for a meeting we actually joined/left.
const LIVEKIT = 11, ONLINE = 1;
const status = (s) => ({ setPlayerDetailsMessage: { availabilityStatus: s } });

test("availability: LIVEKIT after the dwell join, ONLINE after the linger leave", async () => {
  const { sent, enter, leave } = harness({ meeting: { areaAvailabilityStatus: LIVEKIT } });
  enter();
  await sleep(600);
  assert.deepEqual(sent, [], "nothing before the dwell");
  await sleep(1200);
  assert.deepEqual(sent, [status(LIVEKIT)]);
  leave();
  await sleep(800);
  assert.deepEqual(sent, [status(LIVEKIT)], "nothing during the linger");
  await sleep(2200);
  assert.deepEqual(sent, [status(LIVEKIT), status(ONLINE)]);
});

test("availability: walking through a meeting area sends nothing", async () => {
  const { sent, enter, leave } = harness({ meeting: { areaAvailabilityStatus: LIVEKIT } });
  enter();
  await sleep(400);
  leave();
  await sleep(2000);
  assert.deepEqual(sent, []);
});

test("availability: nothing is sent when the adapter has no value", async () => {
  const { joins, leaves, sent, enter, leave } = harness({ meeting: {} });
  enter();
  await sleep(1800);
  leave();
  await sleep(3000);
  assert.deepEqual(joins, ["space-m1"]);
  assert.deepEqual(leaves, ["space-m1"]);
  assert.deepEqual(sent, []);
});

test("availability: with overlapping area meetings, ONLINE only when none remain", async () => {
  const { c, sent } = harness({ meeting: { areaAvailabilityStatus: LIVEKIT } });
  const mk = (id) => ({ id, name: id, rawProps: [{ type: "livekitRoomProperty", id: `m-${id}` }] });
  const [a1, a2] = [mk("A1"), mk("A2")];
  c.currentAreas = new Set(["A1", "A2"]);
  c._handleAreaMeeting(a1, true);
  c._handleAreaMeeting(a2, true);
  await sleep(1800);
  c.currentAreas = new Set(["A2"]);
  c._handleAreaMeeting(a1, false);
  await sleep(2800);
  assert.ok(!sent.some((m) => m.setPlayerDetailsMessage.availabilityStatus === ONLINE), "still in A2");
  c.currentAreas = new Set();
  c._handleAreaMeeting(a2, false);
  await sleep(2800);
  assert.equal(sent.at(-1).setPlayerDetailsMessage.availabilityStatus, ONLINE);
  assert.equal(sent.filter((m) => m.setPlayerDetailsMessage.availabilityStatus === ONLINE).length, 1);
});

test("availability: leaving the area while the join is in flight sends no LIVEKIT and leaves the space", async () => {
  const { c, leaves, sent, enter, leave } = harness({ meeting: { areaAvailabilityStatus: LIVEKIT } });
  let finish;
  c._joinSpace = () => new Promise((res) => { finish = () => { c.spaces.set("space-m1", { spaceUserId: "x" }); res(); }; });
  enter();
  await sleep(1700); // dwell fired, joinSpaceQuery in flight
  leave(); // t.join is already null and the space is not ours yet: no linger is armed
  finish();
  await sleep(50);
  assert.deepEqual(sent.filter((m) => m.setPlayerDetailsMessage), [], "no LIVEKIT while outside");
  assert.deepEqual(leaves, ["space-m1"], "the stray space is left");
  assert.ok(!c.spaces.has("space-m1"));
});

test("availability: a server-initiated leave sends ONLINE", async () => {
  const { c, sent, enter } = harness({ meeting: { areaAvailabilityStatus: LIVEKIT } });
  enter();
  await sleep(1800);
  assert.deepEqual(sent, [status(LIVEKIT)]);
  await c._leaveSpace("space-m1"); // leaveSpaceRequestMessage
  assert.deepEqual(sent.filter((m) => m.setPlayerDetailsMessage), [status(LIVEKIT), status(ONLINE)]);
});
