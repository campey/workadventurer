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
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), [300, 200]);
  assert.equal(calls[0][2].stopWithin, 16);
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

test("moveTo uses a short timeout and rejects when the avatar does not arrive", async () => {
  const w = mkLive();
  w.client.nav = mkNav();
  let opts;
  w.client.navTo = async (x, y, o) => { opts = o; return { arrived: false, reason: "timeout" }; };
  await assert.rejects(() => w.moveTo(300, 200), /did not arrive.*timeout/);
  assert.ok(opts.timeoutMs <= 30000, `timeoutMs ${opts.timeoutMs}`);
  assert.equal(opts.stopWithin, 16);
  assert.ok(opts.signal instanceof AbortSignal);
});

test("close() during a moveTo aborts the walk", async () => {
  const w = mkLive();
  w.client.nav = mkNav();
  w.client.close = () => {};
  let signal;
  w.client.navTo = (x, y, o) => new Promise((res) => {
    signal = o.signal;
    o.signal.addEventListener("abort", () => res({ arrived: false, reason: "aborted" }), { once: true });
  });
  const walking = w.moveTo(300, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(signal.aborted, false);
  w.close();
  assert.equal(signal.aborted, true);
  await assert.rejects(walking, /aborted/);
});

test("close() leaves every space before closing the socket", () => {
  const w = mkLive();
  const order = [];
  w.client.spaces = new Map([["s1", {}], ["s2", {}]]);
  w.client._leaveSpace = async (s) => { order.push(`leave ${s}`); w.client.spaces.delete(s); };
  w.client.close = () => order.push("close");
  w.close();
  assert.deepEqual(order, ["leave s1", "leave s2", "close"]);
});

test("close() still closes when leaving a space throws (the socket is already gone)", () => {
  const w = mkLive();
  const order = [];
  w.client.spaces = new Map([["s1", {}]]);
  w.client._leaveSpace = () => { throw new Error("WebSocket is not open"); };
  w.client.close = () => order.push("close");
  assert.doesNotThrow(() => w.close());
  assert.deepEqual(order, ["close"]);
});

test("openSpotInside: the free tile centre nearest the rectangle centre, inside the rectangle", () => {
  const w = mkLive();
  w.client.nav = mkNav([[5, 5]]); // tile (5,5): px 160..192, centre (176,176)
  const p = w.openSpotInside(128, 128, 96, 96); // centre (176,176) is the solid tile
  assert.ok(!w.isSolid(p.x, p.y));
  assert.ok(p.x > 128 && p.x < 224 && p.y > 128 && p.y < 224, "inside");
  assert.equal(Math.hypot(p.x - 176, p.y - 176), 32, "an adjacent tile");
  w.client.nav = null;
  assert.deepEqual(w.openSpotInside(128, 128, 96, 96), { x: 176, y: 176 });
});
