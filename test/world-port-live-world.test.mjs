import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { LiveWorld } from "../world-port/live/live-world.mjs";

class StubWS extends EventEmitter { close() {} }
const stubFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

test("LiveWorld.close() is idempotent and closes the client once", () => {
  const w = new LiveWorld({ roomUrl: "https://x.test/@/o/w/r", name: "wa-probe-t", fetch: stubFetch, WebSocketImpl: StubWS });
  let n = 0;
  w.client.close = () => { n++; };
  w.close();
  w.close();
  assert.equal(n, 1);
});

test("with RECORD=1, close() saves the recording even if client.close() throws", () => {
  const prev = process.env.RECORD;
  process.env.RECORD = "1";
  let path;
  try {
    const w = new LiveWorld({ roomUrl: "https://x.test/@/o/w/r", name: "wa-probe-rec", fetch: stubFetch, WebSocketImpl: StubWS });
    w.client.close = () => { throw new Error("boom"); };
    assert.throws(() => w.close(), /boom/);
    path = w.recordingPath;
    assert.ok(path && existsSync(path), "recording saved");
    assert.doesNotThrow(() => w.close()); // already closed
  } finally {
    if (prev === undefined) delete process.env.RECORD; else process.env.RECORD = prev;
    if (path) rmSync(path, { force: true });
  }
});

test("client `close` maps to `disconnected` unless we closed it ourselves", () => {
  const mk = () => new LiveWorld({ roomUrl: "https://x.test/@/o/w/r", name: "wa-probe-d", fetch: stubFetch, WebSocketImpl: StubWS });
  const w = mk();
  const got = [];
  w.on("disconnected", (e) => got.push(e));
  w.client.emit("close", { code: 1006, reason: "gone" });
  assert.deepEqual(got, [{ code: 1006, reason: "gone" }]);

  const w2 = mk();
  const got2 = [];
  w2.on("disconnected", (e) => got2.push(e));
  w2.client.close = () => w2.client.emit("close", { code: 1005, reason: "" }); // as the socket would
  w2.close();
  assert.deepEqual(got2, [], "our own close() is not a disconnect");
});

// Realistic movement (#125): people watching see avatars walk, not glide through walls.
import { MapNav } from "../src/map-nav.mjs";

const mkLive = () => new LiveWorld({ roomUrl: "https://x.test/@/o/w/r", name: "wa-probe-m", fetch: stubFetch, WebSocketImpl: StubWS });
// 20x20 tiles of 32 px; tile (5,5) is solid.
const mkNav = (blockedTiles = [[5, 5]]) =>
  new MapNav({ width: 20, height: 20, tile: 32, blocked: blockedTiles.map(([x, y]) => y * 20 + x) });

test("moveTo walks with the client's pathfinding when there is a collision map", async () => {
  const w = mkLive();
  w.client.nav = mkNav();
  const calls = [];
  w.client.navTo = async (x, y, opts) => { calls.push([x, y, opts]); return { arrived: true }; };
  w.client._emitMove = () => assert.fail("must not teleport");
  await w.moveTo(300, 200);
  assert.deepEqual(calls, [[300, 200, { stopWithin: 16 }]]);
});

test("moveTo falls back to a position update when there is no collision map", async () => {
  const w = mkLive();
  w.client.nav = null;
  w.client.navTo = async () => assert.fail("no map, no pathfinding");
  let moves = 0;
  w.client._emitMove = () => { moves++; };
  await w.moveTo(300, 200);
  assert.deepEqual([w.client.pos.x, w.client.pos.y, moves], [300, 200, 1]);
});

test("openSpotNear: a free tile centre outside every meeting area, nearest to the point", () => {
  const w = mkLive();
  w.client.nav = mkNav([[5, 5], [6, 5]]);
  // Meeting area covering tiles x 0..9, y 0..9 (pixels 0..319): everything near (170,170) is inside.
  w.client.areas = [{ name: "M", x: 0, y: 0, w: 320, h: 320, rawProps: [{ type: "livekitRoomProperty", id: "m" }] }];
  const p = w.openSpotNear(170, 170);
  assert.ok(!w.isSolid(p.x, p.y), "open floor");
  assert.ok(p.x >= 320 + 32 || p.y >= 320 + 32, `outside the area (with margin): ${JSON.stringify(p)}`);
  assert.equal((p.x - 16) % 32, 0, "tile centre");
  // Nearest: no other qualifying tile is closer.
  const d = Math.hypot(p.x - 170, p.y - 170);
  for (let tx = 0; tx < 20; tx++) for (let ty = 0; ty < 20; ty++) {
    const [cx, cy] = w.client.nav.tileCenterPx(tx, ty);
    if (w.client.nav.isTileBlocked(tx, ty) || (cx < 352 && cy < 352)) continue;
    assert.ok(Math.hypot(cx - 170, cy - 170) >= d - 1e-9, `(${cx},${cy}) is closer`);
  }
});

test("openSpotNear: ignores non-meeting areas, and a free point outside areas stays its tile centre", () => {
  const w = mkLive();
  w.client.nav = mkNav();
  w.client.areas = [{ name: "Spawn", x: 0, y: 0, w: 640, h: 640, rawProps: [{ type: "start" }] }];
  assert.deepEqual(w.openSpotNear(300, 200), { x: 304, y: 208 });
});

test("openSpotNear without a collision map returns the point unchanged", () => {
  const w = mkLive();
  w.client.nav = null;
  assert.deepEqual(w.openSpotNear(10, 20), { x: 10, y: 20 });
});
