// Issue #65: daemon discovery files and the detached log were shared by every
// daemon (daemon.json / wa-daemon.json / daemon.log), so a bare `wa status`
// addressed whichever daemon started last, and an exiting daemon deleted
// another's advertisement. One file per port instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRegistry, AmbiguousDaemonError } from "../src/daemon-registry.mjs";

function fresh() {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "reg-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "reg-b-"));
  return createRegistry({ dirs: [a, b] });
}

// A pid that is certainly dead: spawn something short and wait for it to exit.
async function deadPid() {
  const p = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => p.on("exit", r));
  return p.pid;
}

test("advertise writes daemon-<port>.json to every dir; list reads it back", () => {
  const reg = fresh();
  reg.advertise({ port: 9001, pid: process.pid, name: "a", room: "r" });
  for (const d of reg.dirs) assert.ok(fs.existsSync(path.join(d, "daemon-9001.json")));
  const l = reg.list();
  assert.equal(l.length, 1);
  assert.deepEqual([l[0].port, l[0].name, l[0].pid], [9001, "a", process.pid]);
});

test("two daemons coexist: one file each, list returns both", () => {
  const reg = fresh();
  reg.advertise({ port: 9001, pid: process.pid, name: "a" });
  reg.advertise({ port: 9002, pid: process.pid, name: "b" });
  assert.deepEqual(reg.list().map((d) => d.port).sort(), [9001, 9002]);
});

test("withdraw removes only that port's file, leaving another daemon's alone", () => {
  const reg = fresh();
  reg.advertise({ port: 9001, pid: process.pid, name: "a" });
  reg.advertise({ port: 9002, pid: process.pid, name: "b" });
  reg.withdraw(9001, process.pid);
  assert.deepEqual(reg.list().map((d) => d.port), [9002]);
});

test("withdraw does not remove a file a different pid now owns", () => {
  const reg = fresh();
  reg.advertise({ port: 9001, pid: process.pid, name: "new owner" });
  reg.withdraw(9001, process.pid + 1); // a stale daemon's late shutdown
  assert.equal(reg.list().length, 1);
});

test("list drops and prunes advertisements whose pid is dead", async () => {
  const reg = fresh();
  reg.advertise({ port: 9001, pid: await deadPid(), name: "crashed" });
  assert.deepEqual(reg.list(), []);
  for (const d of reg.dirs) assert.equal(fs.existsSync(path.join(d, "daemon-9001.json")), false);
});

test("list ignores unreadable / foreign files", () => {
  const reg = fresh();
  fs.writeFileSync(path.join(reg.dirs[0], "daemon-9003.json"), "{not json");
  fs.writeFileSync(path.join(reg.dirs[0], "daemon.json"), JSON.stringify({ port: 8787, pid: process.pid }));
  assert.deepEqual(reg.list(), []);
});

test("resolvePort: explicit port always wins, even with daemons advertised", () => {
  const reg = fresh();
  reg.advertise({ port: 9001, pid: process.pid, name: "a" });
  reg.advertise({ port: 9002, pid: process.pid, name: "b" });
  assert.equal(reg.resolvePort({ explicit: 9100, fallback: 8787 }), 9100);
});

test("resolvePort: exactly one live daemon is addressed", () => {
  const reg = fresh();
  reg.advertise({ port: 9001, pid: process.pid, name: "a" });
  assert.equal(reg.resolvePort({ explicit: null, fallback: 8787 }), 9001);
});

test("resolvePort: none advertised falls back to the default port", () => {
  assert.equal(fresh().resolvePort({ explicit: null, fallback: 8787 }), 8787);
});

test("resolvePort: several daemons is an error that lists them and says to pass --port", () => {
  const reg = fresh();
  reg.advertise({ port: 9001, pid: process.pid, name: "alpha", room: "roomA" });
  reg.advertise({ port: 9002, pid: process.pid, name: "beta", room: "roomB" });
  assert.throws(
    () => reg.resolvePort({ explicit: null, fallback: 8787 }),
    (e) =>
      e instanceof AmbiguousDaemonError &&
      /alpha/.test(e.message) && /9002/.test(e.message) && /--port/.test(e.message) &&
      e.daemons.length === 2
  );
});

test("logPath is per port", () => {
  const reg = fresh();
  assert.notEqual(reg.logPath(9001), reg.logPath(9002));
  assert.match(reg.logPath(9001), /daemon-9001\.log$/);
});
