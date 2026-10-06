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
    sleep: noSleep,
    log: (...a) => logs.push(a.join(" ")),
    delays: [1, 2, 3, 4, 5],
    isStopped: overrides.isStopped ?? (() => false),
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
