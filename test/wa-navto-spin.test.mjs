// _navTo's "no path found" fallback used to discard walkTo()'s own result
// and unconditionally `continue`, re-running findPath() on every iteration.
// With a jittery getTarget() (e.g. frontOf() re-resolving against a player
// moving inside a crowded cluster of avatars), walkTo() can report `arrived`
// on its very first internal check -- before it ever takes a step, so before
// its own per-step tickMs sleep runs. Discarding that result turned this into
// an unthrottled spin: recompute target -> findPath fails -> walkTo -> repeat,
// with no delay anywhere in the cycle. Reproduced live: 100%+ CPU, 1GB+ RSS,
// and the process didn't even respond to SIGTERM promptly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";

function harness() {
  const c = new WorkAdventureClient({ adapter: { envelope: "seq-len-v1" } });
  c._send = () => {};
  c.nav = { findPath: () => [] }; // always "no path" -- forces the fallback branch under test
  return c;
}

test("_navTo stops as soon as walkTo's fallback reports arrived, instead of re-spinning findPath", async () => {
  const c = harness();
  let findPathCalls = 0;
  c.nav.findPath = () => {
    findPathCalls++;
    return [];
  };

  // Alternates far/near on every getTarget() call: the outer loop's own
  // distance check sees "far" (so it proceeds past the early-arrival check
  // into the findPath/walkTo fallback), while walkTo's own internal
  // re-sample sees "near" and reports arrived immediately, without ever
  // stepping or sleeping -- exactly the jitter pattern that caused the spin.
  let calls = 0;
  const getTarget = () => {
    calls++;
    return calls % 2 === 1
      ? { x: c.pos.x + 500, y: c.pos.y }
      : { x: c.pos.x, y: c.pos.y };
  };

  const r = await c.navTo(c.pos.x, c.pos.y, {
    stopWithin: 48,
    getTarget,
    timeoutMs: 300, // safety bound only -- the fix should return long before this
    repathMs: 2000,
  });

  assert.equal(r.arrived, true, "walkTo's own arrival result must be trusted, not discarded");
  assert.equal(findPathCalls, 1, "must not keep re-planning once walkTo reports arrived");
});

test("_navTo throttles even when every waypoint resolves as already-arrived instantly", async () => {
  const c = harness();
  let findPathCalls = 0;
  // A path whose waypoints are already at our current position -- each
  // walkTo() call for one of these resolves "arrived" on its very first
  // internal check, with zero steps and zero tickMs sleep. This is the
  // second shape the live crash took: findPath *succeeds*, but blitzing
  // through a whole waypoint list without ever sleeping is just as tight a
  // spin as the "no path" fallback case covered above.
  c.nav.findPath = () => {
    findPathCalls++;
    return [[c.pos.x, c.pos.y], [c.pos.x, c.pos.y], [c.pos.x, c.pos.y]];
  };

  // Always "far" from the outer loop's own perspective, so it can never
  // short-circuit via the early-arrival check and must go through
  // findPath/waypoint-walking on every single iteration.
  const getTarget = () => ({ x: c.pos.x + 500, y: c.pos.y });

  const r = await c.navTo(c.pos.x, c.pos.y, { stopWithin: 48, getTarget, timeoutMs: 250, repathMs: 2000 });

  assert.equal(r.arrived, false);
  assert.equal(r.reason, "timeout");
  // Without a per-iteration floor this would spin through many hundreds of
  // iterations in 250ms (bounded only by CPU speed); with a ~50ms floor per
  // iteration, at most ~6 or so calls fit in that window.
  assert.ok(findPathCalls <= 10, `expected throttling to cap iterations, got ${findPathCalls} findPath calls`);
});

test("_navTo still returns target-gone promptly from the fallback branch, not just at the top", async () => {
  const c = harness();
  c.nav.findPath = () => [];

  let calls = 0;
  const getTarget = () => {
    calls++;
    // First call (the outer loop's own check): far, so we reach the
    // fallback. Second call (inside walkTo): target has vanished.
    if (calls === 1) return { x: c.pos.x + 500, y: c.pos.y };
    return null;
  };

  const r = await c.navTo(c.pos.x, c.pos.y, {
    stopWithin: 48,
    getTarget,
    timeoutMs: 300,
    repathMs: 2000,
  });

  assert.equal(r.arrived, false);
  assert.equal(r.reason, "target-gone");
});
