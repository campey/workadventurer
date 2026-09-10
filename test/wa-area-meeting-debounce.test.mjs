// Walking *through* a livekitRoomProperty area must not spin a meeting space
// up and back down — that churn OOMs the daemon and floods peers. Only a real
// dwell joins; a brief exit lingers before tearing down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkAdventureClient } from "../src/wa-client.mjs";

function harness() {
  const c = new WorkAdventureClient({
    adapter: {
      envelope: "seq-len-v1",
      areaMeetingSpaceName: (_u, p) => `space-${p.id}`,
    },
  });
  const joins = [];
  const leaves = [];
  c._joinSpace = async (s) => {
    joins.push(s);
    c.spaces.set(s, { spaceUserId: "x" });
  };
  c._leaveSpace = (s) => {
    leaves.push(s);
    c.spaces.delete(s);
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
  return { c, joins, leaves, enter, leave };
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
