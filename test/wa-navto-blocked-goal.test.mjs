// Issue: navTo to a goal that sits inside a solid (a table, a wall) walked to the nearest free tile and then
// never finished. findPath snaps the goal to that tile, but the arrival test used the original, unsnapped point,
// so the loop re-planned a zero-length route until its timeout. Reported from the afrolabs "Red Table" pocket
// (walking out to the north-east), in both the CLI and the APK. Uses the baked afrolabs collision map.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";
import { MapNav } from "../src/map-nav.mjs";

const nav = MapNav.load(new URL("../map/afrolabs/afrolabs/open-space/collision.json", import.meta.url).pathname);
const red = nav.areas.find((a) => a.name === "Red Table");

function clientInRedTable() {
  const c = new WorkAdventureClient({ adapter: { envelope: "seq-len-v1" } });
  c.nav = nav;
  c._emitMove = () => {};
  [c.pos.x, c.pos.y] = nav.tileCenterPx(...nav.nearestFree(...nav.pxToTile(red.x + red.w / 2, red.y + red.h / 2)));
  return c;
}

// A solid tile north-east of the pocket, found rather than hard-coded.
function solidGoalNorthEast(c) {
  for (let r = 4; r < 24; r++) {
    for (let k = 4; k < 24; k++) {
      const x = c.pos.x + r * 32, y = c.pos.y - k * 32;
      if (nav.isPxBlocked(x, y) && nav.findPath(c.pos.x, c.pos.y, x, y)) return { x, y };
    }
  }
  throw new Error("no solid goal found north-east of the Red Table");
}

test("navTo to a goal inside a solid ends at the nearest reachable free tile instead of timing out", async () => {
  const c = clientInRedTable();
  const goal = solidGoalNorthEast(c);
  assert.ok(nav.isPxBlocked(goal.x, goal.y), "precondition: the goal is solid");
  const t = Date.now();
  const r = await c.navTo(goal.x, goal.y, { stopWithin: 16, timeoutMs: 15000 });
  assert.equal(r.arrived, true, `got ${JSON.stringify(r)}`);
  assert.equal(r.snapped, true, "the caller is told the goal was moved to a free tile");
  assert.ok(Date.now() - t < 8000, "ends promptly, not at the timeout");
  assert.ok(!nav.isPxBlocked(c.pos.x, c.pos.y), "never ends inside a solid");
});

test("navTo to a free goal is unchanged (not flagged snapped)", async () => {
  const c = clientInRedTable();
  const r = await c.navTo(c.pos.x + 200, c.pos.y - 200, { stopWithin: 16, timeoutMs: 15000 });
  assert.equal(r.arrived, true);
  assert.notEqual(r.snapped, true);
});

test("navTo to a free goal whose tile centre is further than stopWithin walks the last step and arrives", async () => {
  const c = clientInRedTable();
  // (+300,-300) is free but its tile centre is 17 px away: with stopWithin 16 the walk used to stop on the centre and spin.
  const gx = c.pos.x + 300, gy = c.pos.y - 300;
  assert.ok(!nav.isPxBlocked(gx, gy));
  const r = await c.navTo(gx, gy, { stopWithin: 16, timeoutMs: 15000 });
  assert.equal(r.arrived, true, `got ${JSON.stringify(r)}`);
  assert.ok(Math.hypot(c.pos.x - gx, c.pos.y - gy) <= 16);
});
