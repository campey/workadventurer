import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { FakeServer } from "../world-port/fake/fake-server.mjs";
import { FakeWorld } from "../world-port/fake/fake-world.mjs";

// Live, an avatar knows another only after the server has announced it (playerJoined);
// the fake must not read shared server state (#125, first live run: invites.feature).
const pair = async () => {
  const server = new FakeServer();
  const a = new FakeWorld({ server, name: "wa-probe-a" });
  const b = new FakeWorld({ server, name: "wa-probe-b" });
  await a.connect();
  await b.connect();
  return { a, b };
};

test("an avatar does not know another until it has been told (players and invite)", async () => {
  const { a, b } = await pair();
  assert.deepEqual(a.players(), []);
  assert.throws(() => a.invite("wa-probe-b"), /unknown player "wa-probe-b"/);
  b.close(); a.close();
});

test("after playerJoined is delivered the avatar is known and can invite", async () => {
  const { a, b } = await pair();
  await tick();
  assert.deepEqual(a.players().map((p) => p.name), ["wa-probe-b"]);
  assert.deepEqual(b.players().map((p) => p.name), ["wa-probe-a"]); // the newcomer is told of those already there
  a.invite("wa-probe-b");
  a.close(); b.close();
});

test("a known avatar's position follows playerMoved", async () => {
  const { a, b } = await pair();
  await tick();
  await b.moveTo(500, 600);
  const p = a.players().find((q) => q.name === "wa-probe-b");
  assert.deepEqual([p.x, p.y], [500, 600]);
  a.close(); b.close();
});

test("playerLeft drops the avatar: not listed, not invitable", async () => {
  const { a, b } = await pair();
  await tick();
  b.close();
  assert.deepEqual(a.players(), []);
  assert.throws(() => a.invite("wa-probe-b"), /unknown player/);
  a.close();
});

test("an avatar that left before being announced is never announced", async () => {
  const { a, b } = await pair();
  b.close();
  await tick();
  assert.deepEqual(a.players(), []);
  a.close();
});
