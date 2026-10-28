// A meeting area is modal (#179): while we stand in a livekitRoomProperty area we
// never hold a proximity space. Server requests to join one are refused, and
// entering an area ejects any proximity space we were already in. Otherwise the
// bubble knocks us off the area's LiveKit meeting and nothing brings us back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";

const PROX = "https://play.workadventu.re/@/o/w/campus#2041#1793172650962";

function harness() {
  const c = new WorkAdventureClient({
    adapter: { envelope: "seq-len-v1", areaMeetingSpaceName: (_u, p) => `space-${p.id}` },
  });
  const joined = [];
  const left = [];
  c._joinSpace = async (s) => { joined.push(s); c.spaces.set(s, { spaceUserId: "x" }); };
  c._leaveSpace = (s) => { left.push(s); c.spaces.delete(s); };
  c._joined = true;
  c._send = () => {};
  const area = {
    id: "A1", name: "Meeting", x: 0, y: 0, w: 100, h: 100,
    rawProps: [{ type: "livekitRoomProperty", id: "m1" }],
  };
  const enter = () => { c.currentAreas = new Set(["A1"]); c._handleAreaMeeting(area, true); };
  const leave = () => { c.currentAreas = new Set(); c._handleAreaMeeting(area, false); };
  const serverAsksToJoin = (spaceName) => c._handle({ joinSpaceRequestMessage: { spaceName } });
  return { c, joined, left, enter, leave, serverAsksToJoin };
}

test("outside a meeting area a proximity join request is accepted", () => {
  const { joined, serverAsksToJoin } = harness();
  serverAsksToJoin(PROX);
  assert.deepEqual(joined, [PROX]);
});

test("inside a meeting area a proximity join request is refused", () => {
  const { joined, enter, serverAsksToJoin } = harness();
  enter();
  serverAsksToJoin(PROX);
  assert.deepEqual(joined, []);
});

test("inside a meeting area the area's own space is still accepted", () => {
  const { joined, enter, serverAsksToJoin } = harness();
  enter();
  serverAsksToJoin("space-m1");
  assert.deepEqual(joined, ["space-m1"]);
});

test("entering a meeting area leaves a proximity space we were in", () => {
  const { c, left, enter, serverAsksToJoin } = harness();
  serverAsksToJoin(PROX);
  enter();
  assert.deepEqual(left, [PROX]);
  assert.ok(!c.spaces.has(PROX));
});

test("entering a meeting area does not leave a space that is an area meeting", () => {
  const { c, left, enter } = harness();
  c.spaces.set("space-other", { spaceUserId: "y" });
  c._meetingAreaSpaces.set("B1", "space-other"); // we are also standing in B1
  enter();
  assert.deepEqual(left, []);
  assert.ok(c.spaces.has("space-other"));
});

test("after leaving the area proximity requests are accepted again", () => {
  const { joined, enter, leave, serverAsksToJoin } = harness();
  enter();
  leave();
  serverAsksToJoin(PROX);
  assert.deepEqual(joined, [PROX]);
});
