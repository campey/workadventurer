import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { FakeServer } from "../world-port/fake/fake-server.mjs";
import { FakeWorld } from "../world-port/fake/fake-world.mjs";

// Test-only fixture; not a facts file and not a claim about any real map.
const facts = { meetingAreas: [{ name: "fixture room", x: 1000, y: 1000, w: 100, h: 100, confirmedBy: "fixture" }] };
const make = (opts = {}) => {
  const w = new FakeWorld({ server: new FakeServer(), name: "wa-probe-t", facts, dwellMs: 30, lingerMs: 30, ...opts });
  const log = [];
  for (const e of ["areaEntered", "areaLeft", "meetingJoined", "meetingLeft"]) w.on(e, (p) => log.push([e, p]));
  return { w, log };
};

test("entering a facts-listed meeting area joins its meeting only after the dwell", async () => {
  const { w, log } = make();
  await w.connect();
  await w.moveTo(1050, 1050);
  assert.deepEqual(log, [["areaEntered", { name: "fixture room" }]]);
  await sleep(80);
  assert.deepEqual(log[1], ["meetingJoined", { spaceName: "fixture room" }]);
  w.close();
});

test("walking through a meeting area never joins its meeting", async () => {
  const { w, log } = make({ dwellMs: 60 });
  await w.connect();
  await w.moveTo(1050, 1050);
  await w.moveTo(2000, 2000);
  await sleep(120);
  assert.deepEqual(log.map((l) => l[0]), ["areaEntered", "areaLeft"]);
  w.close();
});

test("leaving a joined meeting area ends the meeting after the linger", async () => {
  const { w, log } = make();
  await w.connect();
  await w.moveTo(1050, 1050);
  await sleep(80);
  await w.moveTo(2000, 2000);
  assert.equal(log.at(-1)[0], "areaLeft");
  await sleep(80);
  assert.deepEqual(log.at(-1), ["meetingLeft", { spaceName: "fixture room" }]);
  w.close();
});

test("default dwell is 1.5 s and linger 2.5 s (docs/field-notes.md)", () => {
  const w = new FakeWorld({ server: new FakeServer(), name: "wa-probe-t" });
  assert.deepEqual([w.dwellMs, w.lingerMs], [1500, 2500]);
});

test("avatars within 64 px share a meeting; moving apart ends it", async () => {
  const server = new FakeServer();
  const a = new FakeWorld({ server, name: "wa-probe-a" });
  const b = new FakeWorld({ server, name: "wa-probe-b" });
  const got = { a: [], b: [] };
  a.on("meetingJoined", (p) => got.a.push(p));
  b.on("meetingJoined", (p) => got.b.push(p));
  a.on("meetingLeft", (p) => got.a.push(["left", p]));
  await a.connect();
  await b.connect();
  await b.moveTo(400, 0);
  await a.moveTo(336, 0); // exactly 64 px away
  assert.equal(got.a.length, 3); // joined at spawn, left, joined again
  assert.deepEqual(got.a.at(-1), got.b.at(-1));
  await a.moveTo(100, 0);
  assert.equal(got.a.at(-1)[0], "left");
  a.close(); b.close();
});
