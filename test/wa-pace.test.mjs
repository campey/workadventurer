// walkTo/navTo take pace: "walk" | "run". With a pace and an adapter speed, stepPx = speed * tickMs / 1000
// (tickMs 100); otherwise the step/tick stay as before (40 px / 100 ms in navTo). Speeds are client-side;
// the server doesn't enforce them (probe observe-humans, 2026-10-11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";
import a133 from "../src/adapters/wa-1.33.mjs";
import a134 from "../src/adapters/wa-1.34.mjs";

function make(adapter) {
  const c = new WorkAdventureClient({ adapter });
  c.nav = null;
  const calls = [];
  c.pos = { x: 0, y: 0 };
  c._emitMove = () => {};
  c.walkTo = async (x, y, o) => { calls.push(o); c.pos.x = x; c.pos.y = y; return { arrived: true }; };
  return { c, calls };
}

test("wa-1.34 defines walk 180 and run 460 px/s; wa-1.33 defines none", () => {
  assert.deepEqual(a134.movement, { walkPxPerS: 180, runPxPerS: 460 });
  assert.equal(a133.movement, undefined);
});

test("navTo pace derives stepPx = speed * 100 / 1000", async () => {
  const w = make(a134);
  await w.c.navTo(10, 10, { pace: "walk" });
  assert.equal(w.calls[0].stepPx, 18);
  assert.equal(w.calls[0].tickMs, 100);
  const r = make(a134);
  await r.c.navTo(10, 10, { pace: "run" });
  assert.equal(r.calls[0].stepPx, 46);
});

test("navTo with no pace passes no step (unchanged)", async () => {
  const { c, calls } = make(a134);
  await c.navTo(10, 10);
  assert.equal(calls[0].stepPx, undefined);
});

test("navTo pace on an adapter without the value is unchanged", async () => {
  const { c, calls } = make(a133);
  await c.navTo(10, 10, { pace: "walk" });
  assert.equal(calls[0].stepPx, undefined);
});

test("navTo along a route: waypoints step 40 px/100 ms without pace, derived with pace", async () => {
  for (const [pace, want] of [[undefined, 40], ["walk", 18], ["run", 46]]) {
    const { c, calls } = make(a134);
    c.nav = { findPath: () => [[50, 0], [100, 0]] };
    await c.navTo(100, 0, { pace });
    const wp = calls.find((o) => o.stopWithin === 12);
    assert.equal(wp.stepPx, want, String(pace));
    assert.equal(wp.tickMs, 100);
  }
});

test("walkTo pace moves the derived distance per tick", async () => {
  const c = new WorkAdventureClient({ adapter: a134 });
  c.pos = { x: 0, y: 0 };
  c._emitMove = () => {};
  await c.walkTo(1000, 0, { pace: "walk", stopWithin: 0, timeoutMs: 150 });
  assert.equal(c.pos.x % 18, 0);
  assert.ok(c.pos.x >= 18 && c.pos.x <= 36);
});
