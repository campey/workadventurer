// A real browser announces availabilityStatus LIVEKIT while it stands in a
// livekitRoomProperty area, and the server then keeps it out of proximity
// bubbles. We announced ONLINE the whole time, so two bots arriving next to each
// other were grouped into a bubble that knocked the first off the area's LiveKit
// meeting (red mic, #177).

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";

const ONLINE = 1;
const LIVEKIT = 11;

function harness() {
  const c = new WorkAdventureClient({
    adapter: { envelope: "seq-len-v1", areaMeetingSpaceName: (_u, p) => `space-${p.id}` },
  });
  c._joinSpace = async (s) => c.spaces.set(s, { spaceUserId: "x" });
  c._leaveSpace = (s) => c.spaces.delete(s);
  c._joined = true;
  const sent = [];
  c._send = (m) => sent.push(m);
  const statuses = () =>
    sent.filter((m) => m.setPlayerDetailsMessage?.availabilityStatus != null)
      .map((m) => m.setPlayerDetailsMessage.availabilityStatus);
  const mk = (id) => ({
    id, name: id, x: 0, y: 0, w: 100, h: 100,
    rawProps: [{ type: "livekitRoomProperty", id: `m-${id}` }],
  });
  const plain = { id: "P", name: "plain", x: 0, y: 0, w: 100, h: 100, rawProps: [] };
  return { c, sent, statuses, mk, plain };
}

test("entering a meeting area announces LIVEKIT immediately, leaving restores ONLINE", () => {
  const { c, statuses, mk } = harness();
  const a = mk("A1");
  c.currentAreas = new Set(["A1"]);
  c._handleAreaMeeting(a, true);
  assert.deepEqual(statuses(), [LIVEKIT]);
  c.currentAreas = new Set();
  c._handleAreaMeeting(a, false);
  assert.deepEqual(statuses(), [LIVEKIT, ONLINE]);
});

test("re-entering the same area does not re-announce", () => {
  const { c, statuses, mk } = harness();
  const a = mk("A1");
  c.currentAreas = new Set(["A1"]);
  c._handleAreaMeeting(a, true);
  c._handleAreaMeeting(a, true);
  assert.deepEqual(statuses(), [LIVEKIT]);
});

test("overlapping meeting areas: ONLINE only after the last one is left", () => {
  const { c, statuses, mk } = harness();
  const a = mk("A1");
  const b = mk("B1");
  c.currentAreas = new Set(["A1", "B1"]);
  c._handleAreaMeeting(a, true);
  c._handleAreaMeeting(b, true);
  c.currentAreas = new Set(["B1"]);
  c._handleAreaMeeting(a, false);
  assert.deepEqual(statuses(), [LIVEKIT]);
  c.currentAreas = new Set();
  c._handleAreaMeeting(b, false);
  assert.deepEqual(statuses(), [LIVEKIT, ONLINE]);
});

test("an area without a livekit meeting leaves the status alone", () => {
  const { c, statuses, plain } = harness();
  c._handleAreaMeeting(plain, true);
  c._handleAreaMeeting(plain, false);
  assert.deepEqual(statuses(), []);
});

test("the stored status is what a (re)join announces", () => {
  const { c, mk } = harness();
  c.currentAreas = new Set(["A1"]);
  c._handleAreaMeeting(mk("A1"), true);
  assert.equal(c.availabilityStatus, LIVEKIT);
});
