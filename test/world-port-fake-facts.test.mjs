import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeServer } from "../world-port/fake/fake-server.mjs";
import { FakeWorld } from "../world-port/fake/fake-world.mjs";
import { LiveWorld } from "../world-port/live/live-world.mjs";

// Test-only fixture; not a facts file and not a claim about any real map.
const facts = {
  startArea: { x: 100, y: 200, w: 64, h: 32, confirmedBy: "fixture" },
  landmarks: [
    { name: "wall", x: 10, y: 20, solid: true, confirmedBy: "fixture" },
    { name: "floor", x: 30, y: 40, solid: false, confirmedBy: "fixture" },
  ],
};
const fake = (f) => new FakeWorld({ server: new FakeServer(), name: "wa-probe-t", facts: f });

test("fake startArea() returns the fixture rectangle", () => {
  assert.deepEqual(fake(facts).startArea(), { x: 100, y: 200, w: 64, h: 32 });
});

test("fake startArea() is null without facts", () => {
  assert.equal(fake({}).startArea(), null);
  assert.equal(fake(undefined).startArea(), null);
});

test("fake joining places the avatar at the start area centre", async () => {
  const w = fake(facts);
  await w.connect();
  assert.deepEqual([w.self().x, w.self().y], [132, 216]);
});

test("fake joining without a start area leaves position at origin", async () => {
  const w = fake({});
  await w.connect();
  assert.deepEqual([w.self().x, w.self().y], [0, 0]);
});

test("fake isSolid answers a named landmark's point", () => {
  const w = fake(facts);
  assert.equal(w.isSolid(10, 20), true);
  assert.equal(w.isSolid(30, 40), false);
});

test("fake isSolid on an unknown point throws, never guesses", () => {
  assert.throws(() => fake(facts).isSolid(1, 2), { message: "fake has no fact for (1,2)" });
  assert.throws(() => fake({}).isSolid(5, 6), { message: "fake has no fact for (5,6)" });
});

class StubWS { on() {} close() {} }
const live = () => new LiveWorld({ roomUrl: "https://x.test/@/o/w/r", name: "wa-probe-t", fetch: async () => ({}), WebSocketImpl: StubWS });
const area = (name, x, rawProps) => ({ name, x, y: 1, w: 2, h: 3, rawProps });

test("live startArea() prefers the isDefault start area", () => {
  const w = live();
  w.client.areas = [
    area("a", 0, [{ type: "start" }]),
    area("b", 5, [{ type: "start", isDefault: true }]),
    area("c", 9, []),
  ];
  assert.deepEqual(w.startArea(), { x: 5, y: 1, w: 2, h: 3 });
});

test("live startArea() falls back to the first start area, null if none", () => {
  const w = live();
  w.client.areas = [area("c", 9, []), area("a", 7, [{ type: "start" }])];
  assert.deepEqual(w.startArea(), { x: 7, y: 1, w: 2, h: 3 });
  w.client.areas = [area("c", 9, [])];
  assert.equal(w.startArea(), null);
  w.client.areas = undefined;
  assert.equal(w.startArea(), null);
});

test("live isSolid uses nav.isPxBlocked; throws without a collision map", () => {
  const w = live();
  w.client.nav = { isPxBlocked: (x, y) => x === 1 && y === 2 };
  assert.equal(w.isSolid(1, 2), true);
  assert.equal(w.isSolid(3, 4), false);
  w.client.nav = null;
  assert.throws(() => w.isSolid(1, 2), { message: "no collision map for this room" });
});

test("live playerLeft carries the name, though the client deletes the player first", () => {
  const w = live();
  const got = [];
  w.on("playerLeft", (p) => got.push(p));
  w.client.emit("playerJoined", { userId: 7, name: "wa-probe-b", x: 1, y: 2 });
  w.client.emit("playerLeft", 7); // client.players no longer has 7
  assert.deepEqual(got, [{ userId: 7, name: "wa-probe-b" }]);
});
