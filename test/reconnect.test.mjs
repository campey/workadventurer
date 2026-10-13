// Issue #56: every reconnect attempt's client used to be wired with the
// reconnect-on-close handler, so each rejected attempt (server closes the
// socket) started another concurrent chain — attempts grew ~2^N. The
// reconnector owns the "one chain" invariant.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createReconnector } from "../src/reconnect.mjs";
import { ServerRejectedError } from "../src/server-rejected.mjs";

const noSleep = () => Promise.resolve();

// A client whose connect() fails the way a rejected one does: the socket
// closes (emitting "close") and connect() rejects.
function failingClient(err = new Error("closed before join")) {
  const c = new EventEmitter();
  c.connect = async () => {
    c.emit("close", { code: 1000, reason: "Error message sent" });
    throw err;
  };
  c.close = () => {};
  return c;
}

function harness(overrides = {}) {
  const made = [];
  const logs = [];
  const r = createReconnector({
    makeClient: () => {
      const c = failingClient(overrides.err);
      // The OLD daemon wired every attempt client like this:
      c.on("close", () => r.start().catch(() => {}));
      made.push(c);
      return c;
    },
    onConnected: overrides.onConnected ?? (() => {}),
    log: (...a) => logs.push(a.join(" ")),
    delays: [1, 2, 3, 4, 5],
    maxAttempts: overrides.maxAttempts ?? 5,
    isStopped: overrides.isStopped ?? (() => false),
    sleep: overrides.sleep ?? noSleep,
  });
  return { r, made, logs };
}

test("N failed attempts that each emit close make exactly N attempts, not 2^N", async () => {
  const { r, made } = harness();
  await assert.rejects(r.start(), /exhausted reconnect attempts/);
  assert.equal(made.length, 5);
});

test("start() while a chain is running joins it instead of starting another", async () => {
  const { r, made } = harness();
  const a = r.start();
  const b = r.start();
  assert.equal(a, b);
  await assert.rejects(a);
  assert.equal(made.length, 5);
});

test("a fatal ServerRejectedError stops after the first attempt", async () => {
  const err = new ServerRejectedError({ code: "NEW_VERSION" });
  const { r, made } = harness({ err });
  await assert.rejects(r.start(), (e) => e === err);
  assert.equal(made.length, 1);
});

test("a retryable ServerRejectedError keeps retrying (bounded)", async () => {
  const err = new ServerRejectedError({ code: "OTHER", timeToRetry: 30 });
  const { r, made } = harness({ err });
  await assert.rejects(r.start(), /exhausted/);
  assert.equal(made.length, 5);
});

test("deliberate shutdown is checked every iteration", async () => {
  let stopped = false;
  const { r, made } = harness({ isStopped: () => stopped });
  const sleeps = [];
  // stop after the second attempt
  const orig = made.push.bind(made);
  made.push = (c) => { orig(c); if (made.length === 2) stopped = true; };
  await assert.rejects(r.start(), /shut down/);
  assert.equal(made.length, 2);
});

test("success calls onConnected with the client and ends the chain", async () => {
  let connected = null;
  const r = createReconnector({
    makeClient: () => Object.assign(new EventEmitter(), { connect: async () => {}, close() {} }),
    onConnected: (c) => { connected = c; },
    sleep: noSleep,
    log: () => {},
    delays: [1, 2],
    isStopped: () => false,
  });
  await r.start();
  assert.ok(connected);
  // a later failure can start a fresh chain
  await r.start();
});

test("by default it never gives up on retryable failures (a long outage is survivable)", async () => {
  let made = 0;
  let stopAt = 40;
  const r = createReconnector({
    makeClient: () => { made++; return failingClient(); },
    onConnected: () => {},
    sleep: noSleep,
    log: () => {},
    delays: [1, 2],
    isStopped: () => made >= stopAt,
  });
  await assert.rejects(r.start(), /shut down/);
  assert.equal(made, 40); // far past the old cap of 5, ended only by shutdown
});

test("the delay stays at the last (capped) value once the schedule is exhausted", async () => {
  const slept = [];
  const { r } = harness({ maxAttempts: 6, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } });
  await assert.rejects(r.start(), /exhausted/);
  assert.deepEqual(slept, [1, 2, 3, 4, 5, 5]);
});

test("a failed attempt logs the underlying cause code, not just 'fetch failed'", async () => {
  const err = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) });
  const { r, logs } = harness({ err, maxAttempts: 1 });
  await assert.rejects(r.start());
  assert.ok(logs.some((l) => /fetch failed.*ENOTFOUND/.test(l)), logs.join("\n"));
});

test("attempt log lines show how long we have been down", async () => {
  let t = 0;
  const logs = [];
  const r = createReconnector({
    makeClient: () => failingClient(),
    onConnected: () => {},
    sleep: async (ms) => { t += ms; },
    now: () => t,
    log: (...a) => logs.push(a.join(" ")),
    delays: [60_000],
    maxAttempts: 3,
  });
  await assert.rejects(r.start());
  assert.ok(logs.some((l) => /attempt 3.*down 3m/.test(l)), logs.join("\n"));
});
