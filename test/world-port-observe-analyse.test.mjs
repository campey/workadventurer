// analyse(): timings, speeds and geometry from a raw observation log (made-up events).
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyse, rectDistance } from "../world-port/probes/observe-humans.mjs";

const pit = { x: 100, y: 100, w: 200, h: 100, name: "Fire Pit" };

test("rectDistance: outside is positive px to the edge, inside is negative depth", () => {
  assert.equal(rectDistance(90, 150, pit), 10);
  assert.equal(rectDistance(100, 150, pit), 0);
  assert.equal(rectDistance(150, 150, pit), -50);
  assert.equal(rectDistance(60, 60, pit), Math.round(Math.hypot(40, 40)));
});

test("entry, status flip, space join and exit are lined up with signed ms and edge distances", () => {
  const H = "Human";
  const ev = [];
  // walks east at 200 px/s along y=150, one sample per 100 ms, from x=40 to x=340
  for (let i = 0; i <= 15; i++) ev.push({ t: 1000 + i * 100, kind: "pos", name: H, x: 40 + i * 20, y: 150, moving: true });
  // enters (x>=100) at t=1300; status LIVEKIT 200 ms before; joins space 900 ms after; exits (x>300) at t=2400
  ev.push({ t: 1100, kind: "status", name: H, status: "LIVEKIT" });
  ev.push({ t: 2200, kind: "spaceAdd", by: "B", spaceName: "9ida9r-fire-pit", name: H });
  ev.push({ t: 2400, kind: "status", name: H, status: "ONLINE" });
  ev.push({ t: 1250, kind: "var", name: H, varName: "currentPlace", value: "Fire Pit" });
  ev.push({ t: 1500, kind: "emote", name: H, emote: "👍" });
  ev.sort((a, b) => a.t - b.t);
  const r = analyse(ev, pit)[H];
  assert.equal(r.samples, 16);
  assert.equal(r.speedPxPerS.shortWindow.median, 200);
  const enter = r.areaEntries[0];
  assert.equal(enter.t, 1300);
  assert.equal(enter.statusFlip.ms, -200);          // status came 200 ms before the position
  assert.equal(enter.spaceJoin.ms, 900);            // space join 900 ms after
  assert.equal(enter.place.ms, -50);
  assert.equal(enter.stayedMs, 1100);
  const flip = r.statusFlips.find((f) => f.status === "LIVEKIT");
  assert.equal(flip.before.dist, 40);               // last known position when the flip arrived (x=60): 40 px outside the edge at x=100
  assert.equal(r.marks[0].emote, "👍");
  assert.equal(r.areaExits[0].statusFlip.ms, 0);
});

test("a pass-through shows as a short stay with no status flip or join near it", () => {
  const ev = [];
  for (let i = 0; i <= 10; i++) ev.push({ t: i * 100, kind: "pos", name: "P", x: 90 + i * 50, y: 150, moving: true }); // fast
  const r = analyse(ev, pit).P;
  assert.equal(r.areaEntries.length, 1);
  assert.ok(r.areaEntries[0].stayedMs < 1500);
  assert.equal(r.areaEntries[0].statusFlip, null);
  assert.equal(r.areaEntries[0].spaceJoin, null);
});
