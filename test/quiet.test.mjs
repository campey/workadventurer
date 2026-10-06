// Issue #81: `wa quiet` is a standalone command — step away to the nearest
// empty area (excluding board room / podium / audience), or stay put if
// already quiet. It used to also pause a continuous follow; that is gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { goQuiet, QUIET_EXCLUDE } from "../src/quiet.mjs";

const rectContains = (a, x, y, m = 0) =>
  x >= a.x - m && x <= a.x + a.w + m && y >= a.y - m && y <= a.y + a.h + m;

function fakeWa({ pos = { x: 0, y: 0 }, here = null, players = [], nearest = null } = {}) {
  const calls = [];
  return {
    calls,
    pos,
    listPlayers: () => players,
    nav: {
      areaAt: () => here,
      _rectContains: rectContains,
      nearestEmptyArea: (x, y, ps, opts) => {
        calls.push(["nearestEmptyArea", opts.excludeRe]);
        return nearest;
      },
    },
    navTo: async (x, y, opts) => {
      calls.push(["navTo", x, y, opts.stopWithin]);
      return { arrived: true };
    },
  };
}

test("walks to the nearest empty area and reports it", async () => {
  const wa = fakeWa({ nearest: { name: "Quiet nook", x: 500, y: 400 } });
  const r = await goQuiet(wa, { log: () => {} });
  assert.deepEqual(r, { ok: true, quietSpot: "Quiet nook" });
  assert.deepEqual(wa.calls.find((c) => c[0] === "navTo"), ["navTo", 500, 400, 64]);
});

test("stays put when already in an empty, non-excluded area", async () => {
  const here = { name: "Phone box", x: 0, y: 0, w: 100, h: 100 };
  const wa = fakeWa({ here, players: [{ x: 900, y: 900 }] });
  const r = await goQuiet(wa, { log: () => {} });
  assert.deepEqual(r, { ok: true, quietSpot: "Phone box", alreadyQuiet: true });
  assert.equal(wa.calls.length, 0);
});

test("does not count an excluded area (board room) as quiet", async () => {
  const here = { name: "Board Room", x: 0, y: 0, w: 100, h: 100 };
  const wa = fakeWa({ here, nearest: { name: "Nook", x: 5, y: 5 } });
  const r = await goQuiet(wa, { log: () => {} });
  assert.equal(r.quietSpot, "Nook");
  assert.notEqual(r.alreadyQuiet, true);
});

test("an area with someone in it is not quiet", async () => {
  const here = { name: "Phone box", x: 0, y: 0, w: 100, h: 100 };
  const wa = fakeWa({ here, players: [{ x: 50, y: 50 }], nearest: { name: "Nook", x: 5, y: 5 } });
  const r = await goQuiet(wa, { log: () => {} });
  assert.equal(r.quietSpot, "Nook");
});

test("no empty area anywhere: ok with quietSpot null, and no walk", async () => {
  const wa = fakeWa({ nearest: null });
  const r = await goQuiet(wa, { log: () => {} });
  assert.deepEqual(r, { ok: true, quietSpot: null });
  assert.equal(wa.calls.some((c) => c[0] === "navTo"), false);
});

test("the result carries no follow state", async () => {
  const r = await goQuiet(fakeWa({ nearest: { name: "n", x: 1, y: 1 } }), { log: () => {} });
  assert.equal("followPaused" in r, false);
});

test("exclusion list is board room / podium / audience", () => {
  for (const n of ["Board Room", "boardroom", "Podium", "Audience"]) assert.ok(QUIET_EXCLUDE.test(n), n);
  assert.equal(QUIET_EXCLUDE.test("Phone box"), false);
});
