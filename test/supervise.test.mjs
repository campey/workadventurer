// #138: supervision. After #144/#147 a network outage no longer ends the daemon,
// so what is left to recover from is the daemon being KILLED (OOM balloon #29,
// SIGKILL) — restart only something that was alive. A failed initial connect
// (exit 1), a server refusal (exit 4) and a deliberate stop (exit 0) all end
// the supervisor too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSupervisor, shouldRestart, REFUSED_EXIT } from "../src/supervise.mjs";

const tick = () => new Promise((r) => setImmediate(r));

function fakeChild() {
  const c = new EventEmitter();
  c.killed = [];
  c.kill = (sig) => { c.killed.push(sig); return true; };
  return c;
}

function harness(opts = {}) {
  const children = [];
  const logs = [];
  const slept = [];
  let clock = 0;
  const sup = createSupervisor({
    start: () => { const c = fakeChild(); children.push(c); return c; },
    log: (m) => logs.push(m),
    sleep: opts.sleep ?? (async (ms) => { slept.push(ms); clock += ms; }),
    now: () => clock,
    delays: [10, 20, 30],
    stableMs: 1000,
  });
  return { sup, children, logs, slept, advance: (ms) => { clock += ms; } };
}

test("shouldRestart: only signal deaths and unexpected codes", () => {
  assert.equal(shouldRestart({ code: 0, signal: null }), false); // deliberate stop
  assert.equal(shouldRestart({ code: 1, signal: null }), false); // never connected / generic failure
  assert.equal(shouldRestart({ code: 2, signal: null }), false);
  assert.equal(shouldRestart({ code: 3, signal: null }), false);
  assert.equal(shouldRestart({ code: REFUSED_EXIT, signal: null }), false); // server refuses us
  assert.equal(shouldRestart({ code: null, signal: "SIGKILL" }), true);
  assert.equal(shouldRestart({ code: null, signal: "SIGABRT" }), true); // node heap OOM
  assert.equal(shouldRestart({ code: 134, signal: null }), true);
});

test("a killed daemon is restarted, and a later clean exit ends the supervisor with 0", async () => {
  const { sup, children, logs } = harness();
  const done = sup.run();
  await tick();
  children[0].emit("exit", null, "SIGKILL");
  await tick(); await tick();
  assert.equal(children.length, 2, "a second daemon was started");
  assert.ok(logs.some((l) => /SIGKILL.*restarting/.test(l)), logs.join("\n"));
  children[1].emit("exit", 0, null);
  assert.equal(await done, 0);
  assert.equal(children.length, 2);
});

test("exit 1 (never connected) is not restarted and its code is returned", async () => {
  const { sup, children } = harness();
  const done = sup.run();
  await tick();
  children[0].emit("exit", 1, null);
  assert.equal(await done, 1);
  assert.equal(children.length, 1);
});

test("a server refusal (exit 4) is not restarted and says why", async () => {
  const { sup, children, logs } = harness();
  const done = sup.run();
  await tick();
  children[0].emit("exit", REFUSED_EXIT, null);
  assert.equal(await done, REFUSED_EXIT);
  assert.equal(children.length, 1);
  assert.ok(logs.some((l) => /refus/i.test(l)), logs.join("\n"));
});

test("consecutive crashes back off through the schedule and then hold the last delay", async () => {
  const { sup, children, slept } = harness();
  const done = sup.run();
  for (let i = 0; i < 5; i++) {
    await tick();
    children[i].emit("exit", null, "SIGKILL");
    await tick();
  }
  await tick();
  children[5].emit("exit", 0, null);
  await done;
  assert.deepEqual(slept, [10, 20, 30, 30, 30]);
});

test("a run that stayed up long enough resets the backoff", async () => {
  const { sup, children, slept, advance } = harness();
  const done = sup.run();
  await tick();
  children[0].emit("exit", null, "SIGKILL"); // quick crash -> 10
  await tick(); await tick();
  children[1].emit("exit", null, "SIGKILL"); // quick crash -> 20
  await tick(); await tick();
  advance(5000); // the third daemon runs for a long time...
  children[2].emit("exit", null, "SIGKILL"); // ...then dies: backoff starts over -> 10
  await tick(); await tick();
  children[3].emit("exit", 0, null);
  await done;
  assert.deepEqual(slept, [10, 20, 10]);
});

test("stop() forwards the signal to the daemon and a resulting exit ends supervision", async () => {
  const { sup, children } = harness();
  const done = sup.run();
  await tick();
  sup.stop("SIGTERM");
  assert.deepEqual(children[0].killed, ["SIGTERM"]);
  children[0].emit("exit", null, "SIGTERM"); // killed by the signal we forwarded: not a crash
  assert.equal(await done, 0);
  assert.equal(children.length, 1);
});

test("stop() during the restart backoff cancels the restart", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { sup, children } = harness({ sleep: () => gate });
  const done = sup.run();
  await tick();
  children[0].emit("exit", null, "SIGKILL");
  await tick();
  sup.stop("SIGTERM");
  release();
  assert.equal(await done, 0);
  assert.equal(children.length, 1);
});
