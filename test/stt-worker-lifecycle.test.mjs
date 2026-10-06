// Issue #57: the STT worker outlived its daemon — stopWorker() had no callers,
// and a SIGKILLed daemon can't clean up after itself anyway. The worker must
// die with its parent, stop() must really stop it, and daemons must not share
// (and so clobber) one socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWorkerManager } from "../src/stt-worker-proc.mjs";
import { SOCK_PATH } from "../src/wa-stt.mjs";

const fakeWorker = fileURLToPath(new URL("../test-support/fake-stt-worker.mjs", import.meta.url));
const spawnHelper = fileURLToPath(new URL("../test-support/spawn-stt-manager.mjs", import.meta.url));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
};
const manager = () =>
  createWorkerManager({
    command: process.execPath,
    args: (sock) => [fakeWorker, "--socket", sock],
    sockPath: `/tmp/fake-stt-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
  });

test("ensure() starts one worker and is idempotent", async () => {
  const m = manager();
  try {
    const a = m.ensure();
    const b = m.ensure();
    assert.equal(a, b);
    await a;
    assert.ok(alive(m.pid));
  } finally {
    await m.stop();
  }
});

test("stop() resolves only after the worker has exited, and ensure() can start a fresh one", async () => {
  const m = manager();
  await m.ensure();
  const first = m.pid;
  await m.stop();
  assert.equal(alive(first), false);
  assert.equal(m.pid, null);
  await m.ensure();
  try {
    assert.notEqual(m.pid, first);
    assert.ok(alive(m.pid));
  } finally {
    await m.stop();
  }
});

test("stop() with no worker running is a no-op", async () => {
  await manager().stop();
});

test("the worker exits when its parent is SIGKILLed", async () => {
  const parent = spawn(process.execPath, [spawnHelper], { stdio: ["ignore", "pipe", "inherit"] });
  const workerPid = await new Promise((resolve, reject) => {
    let out = "";
    parent.stdout.on("data", (c) => {
      out += c;
      const m = /worker-pid (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    parent.on("exit", () => reject(new Error(`parent exited early: ${out}`)));
  });
  assert.ok(alive(workerPid), "worker should be running while the parent lives");
  parent.removeAllListeners("exit");
  parent.kill("SIGKILL");
  const gone = await until(() => !alive(workerPid));
  if (!gone) process.kill(workerPid, "SIGKILL"); // don't leak it from the test
  assert.ok(gone, "worker outlived its SIGKILLed parent");
});

test("the default socket path is per daemon process, so daemons never share a worker", () => {
  assert.ok(SOCK_PATH.includes(`.wa-stt.${process.pid}.sock`), SOCK_PATH);
});
