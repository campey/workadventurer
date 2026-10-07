import { test } from "node:test";
import assert from "node:assert/strict";
import { PreQueue } from "../src/stt-prequeue.mjs";

test("PreQueue drains items in arrival order, then is empty", () => {
  const q = new PreQueue(100);
  q.push("a", 10);
  q.push("b", 10);
  const out = [];
  q.drain((x) => out.push(x));
  assert.deepEqual(out, ["a", "b"]);
  q.drain((x) => out.push(x));
  assert.deepEqual(out, ["a", "b"]);
});

test("PreQueue drops the oldest items once over its size budget", () => {
  const q = new PreQueue(25);
  for (const x of ["a", "b", "c", "d"]) q.push(x, 10);
  const out = [];
  q.drain((x) => out.push(x));
  assert.deepEqual(out, ["c", "d"]);
  assert.equal(q.dropped, 2);
});

test("PreQueue keeps a single item bigger than the budget rather than dropping everything", () => {
  const q = new PreQueue(5);
  q.push("big", 50);
  const out = [];
  q.drain((x) => out.push(x));
  assert.deepEqual(out, ["big"]);
});
