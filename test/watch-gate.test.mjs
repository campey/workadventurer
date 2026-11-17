import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runGate, STEP_NAMES, selfcheckInvocation, scenariosInvocation, kotlinSmokeInvocation,
  createProtoDiffRunner, createScenariosRunner, createKotlinSmokeRunner, createSelfcheckRunner,
  firstFailure, runChild,
} from "../scripts/watch/gate.mjs";

const FILE = { schema: 1, id: "wa-1.34.9", waVersion: "1.34.9", apiVersionHash: "abc12345", server: "production", protoFamily: "wa-1.34" };
const pass = () => ({ ok: true });
const allPass = () => Object.fromEntries(STEP_NAMES.map((n) => [n, pass]));
const gate = (o = {}) => runGate({ file: FILE, server: "production", candidateFile: "/x/c.json", runners: allPass(), ...o });
const names = (r) => r.steps.map((s) => `${s.name}:${s.status}`);

test("all steps pass on production", async () => {
  const seen = [];
  const runners = Object.fromEntries(STEP_NAMES.map((n) => [n, (ctx) => { seen.push([n, ctx.candidateFile, ctx.hash, ctx.server]); return { ok: true }; }]));
  const r = await gate({ runners });
  assert.equal(r.pass, true);
  assert.deepEqual(names(r), STEP_NAMES.map((n) => `${n}:pass`));
  assert.equal(r.candidateFile, "/x/c.json");
  assert.deepEqual(seen.map((s) => s[0]), STEP_NAMES);
  assert.deepEqual(seen[0].slice(1), ["/x/c.json", "abc12345", "production"]);
});

test("staging skips the scenarios and still passes", async () => {
  let ran = false;
  const r = await gate({ server: "staging", runners: { ...allPass(), scenarios: () => { ran = true; return { ok: true }; } } });
  assert.equal(ran, false);
  assert.equal(r.pass, true);
  assert.equal(r.steps[2].status, "skipped");
});

for (const failing of STEP_NAMES) {
  test(`a failing ${failing} stops the gate and later steps are skipped`, async () => {
    const calls = [];
    const runners = Object.fromEntries(STEP_NAMES.map((n) => [n, () => { calls.push(n); return n === failing ? { ok: false, detail: `boom\u0007 in ${n}` } : { ok: true }; }]));
    const r = await gate({ runners });
    assert.equal(r.pass, false);
    const i = STEP_NAMES.indexOf(failing);
    assert.equal(r.steps[i].status, "fail");
    assert.equal(r.steps[i].detail, `boom  in ${failing}`, "control characters are sanitised");
    assert.deepEqual(calls, STEP_NAMES.slice(0, i + 1));
    for (const s of r.steps.slice(i + 1)) assert.equal(s.status, "skipped");
    assert.equal(r.steps.length, STEP_NAMES.length);
  });
}

test("failure detail is capped like gateDetail", async () => {
  const r = await gate({ runners: { ...allPass(), selfcheck: () => ({ ok: false, detail: "x".repeat(500) }) } });
  assert.ok(r.steps[1].detail.length <= 201);
});

test("a step that outlives its timeout fails and is aborted", async () => {
  let aborted = false;
  const slow = ({ signal }) => new Promise((res) => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(() => res({ ok: true }), 5000).unref(); });
  const t0 = Date.now();
  const r = await gate({ runners: { ...allPass(), selfcheck: slow }, timeouts: { selfcheck: 30 } });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.pass, false);
  assert.match(r.steps[1].detail, /timed out/);
  assert.equal(aborted, true);
  assert.equal(r.steps[2].status, "skipped");
});

test("a crashing, throwing-sync or garbage runner is a failed step, never an exception", async () => {
  for (const bad of [() => { throw new Error("kaboom"); }, async () => { throw new Error("async kaboom"); }, () => "yes", () => null, () => ({})]) {
    const r = await gate({ runners: { ...allPass(), "proto-diff": bad } });
    assert.equal(r.pass, false);
    assert.equal(r.steps[0].status, "fail");
    assert.ok(r.steps[0].detail);
  }
});

test("a missing runner fails closed", async () => {
  const r = await gate({ runners: { ...allPass(), selfcheck: undefined } });
  assert.equal(r.pass, false);
  assert.match(r.steps[1].detail, /no runner/);
});

test("bad inputs give a failed result, not a throw", async () => {
  assert.equal((await runGate({})).pass, false);
  assert.equal((await gate({ server: "dev" })).pass, false);
  assert.equal((await gate({ file: null })).steps.length, STEP_NAMES.length);
});

test("without a candidateFile the gate writes the file for the clients", async () => {
  let seen;
  const r = await gate({ candidateFile: undefined, runners: { ...allPass(), selfcheck: (ctx) => { seen = ctx.candidateFile; return { ok: true }; } } });
  assert.equal(r.candidateFile, seen);
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, "utf8")), FILE);
});

// --- argument building for the real runners ---

test("selfcheck gets the candidate via --adapter-file; staging adds room, pusher and woka", () => {
  const p = selfcheckInvocation({ candidateFile: "/c.json", server: "production" });
  assert.deepEqual(p.args.slice(1), ["--target", "production", "--adapter-file", "/c.json"]);
  assert.equal(p.env.NODE_USE_ENV_PROXY, "1");
  const s = selfcheckInvocation({ candidateFile: "/c.json", server: "staging", staging: { room: "https://r/", pusherUrl: "https://p", wokaId: "w1" } });
  assert.deepEqual(s.args.slice(1), ["--target", "wa-master", "--adapter-file", "/c.json", "--room", "https://r/"]);
  assert.equal(s.env.WA_PUSHER_URL, "https://p");
  assert.equal(s.env.WA_WOKA_ID, "w1");
});

test("scenarios run live with WA_ADAPTER_FILE, and only for production", async () => {
  const inv = scenariosInvocation({ candidateFile: "/c.json", server: "production" });
  assert.equal(inv.env.WORLD, "live");
  assert.equal(inv.env.WA_ADAPTER_FILE, "/c.json");
  assert.match(inv.args[0], /scenarios\.mjs$/);
  assert.throws(() => scenariosInvocation({ candidateFile: "/c.json", server: "staging" }));
  let ran = false;
  const r = await createScenariosRunner({ run: async () => { ran = true; return { code: 0, output: "" }; } })({ candidateFile: "/c.json", server: "staging" });
  assert.equal(r.ok, false);
  assert.equal(ran, false);
});

test("kotlin smoke passes the hash and walks to an area; staging adds room and pusher", () => {
  const k = kotlinSmokeInvocation({ hash: "abc12345", server: "production" });
  assert.equal(k.command, "./gradlew");
  assert.match(k.cwd, /android$/);
  const a = k.args.find((x) => x.startsWith("--args="));
  assert.match(a, /--api-version abc12345/);
  assert.match(a, /--walk-to-area Red( |$)/);
  assert.doesNotMatch(a, /--room/);
  const s = kotlinSmokeInvocation({ hash: "d2d82672", server: "staging", staging: { room: "https://s/r", pusherUrl: "https://p" } });
  assert.match(s.args.find((x) => x.startsWith("--args=")), /--room https:\/\/s\/r --pusher https:\/\/p/);
});

test("child runners decide on exit code and, for the smoke, on arrival", async () => {
  const okRun = (output, code = 0) => async () => ({ code, output });
  assert.equal((await createSelfcheckRunner({ run: okRun("OK") })({ candidateFile: "/c", server: "production" })).ok, true);
  const bad = await createSelfcheckRunner({ run: okRun("PASS a\nFAIL  move  — stuck\n\nFAIL", 1) })({ candidateFile: "/c", server: "production" });
  assert.deepEqual([bad.ok, bad.detail], [false, "FAIL  move  — stuck"]);
  const smoke = (o, c) => createKotlinSmokeRunner({ run: okRun(o, c) })({ hash: "abc12345", server: "production" });
  assert.equal((await smoke("· walk ended: ARRIVED", 0)).ok, true);
  assert.equal((await smoke("· walk ended: TIMEOUT", 0)).ok, false);
  assert.equal((await smoke("join failed: nope", 1)).ok, false);
});

test("firstFailure and runChild", async () => {
  assert.equal(firstFailure("a\nb"), "b");
  assert.equal(firstFailure(""), "no output");
  const r = await runChild({ command: process.execPath, args: ["-e", "console.log('hi'); process.exit(3)"] });
  assert.deepEqual([r.code, r.output.trim()], [3, "hi"]);
  const ac = new AbortController();
  const p = runChild({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"], signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  assert.notEqual((await p).code, 0);
  assert.equal((await runChild({ command: "/no/such/bin" })).code, null);
});

// --- the proto-diff runner on real vendored protos ---

test("proto-diff runner: same proto passes; a used removal fails against the right client", async () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const same = path.join(root, "proto/wa-1.34/messages.proto");
  const run = createProtoDiffRunner({ root });
  assert.equal((await run({ file: FILE, candidateProto: same })).ok, true);
  assert.equal((await run({ file: FILE, candidateProto: "/no/such" })).ok, false);

  // A candidate that drops a message: flagged when the Kotlin source mentions it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-proto-"));
  const cand = path.join(tmp, "messages.proto");
  fs.writeFileSync(cand, fs.readFileSync(same, "utf8").replace(/message MoveToPositionMessage\s*\{[^}]*\}/, ""));
  const hit = await createProtoDiffRunner({ root, nodeSources: [], kotlinSources: ["MoveToPositionMessage"] })({ file: FILE, candidateProto: cand });
  assert.equal(hit.ok, false);
  assert.match(hit.detail, /wa-1\.33 \(Android\).*android\/.*MoveToPositionMessage/);
  const nodeHit = await createProtoDiffRunner({ root, nodeSources: ["MoveToPositionMessage"], kotlinSources: [] })({ file: FILE, candidateProto: cand });
  assert.match(nodeHit.detail, /wa-1\.34 \(Node\).*src\//);
  const miss = await createProtoDiffRunner({ root, nodeSources: [], kotlinSources: [] })({ file: FILE, candidateProto: cand });
  assert.equal(miss.ok, true);
});

// --- fix round 1 ---

test("kotlin smoke arguments are validated; each rejection is a failed step, never a throw", async () => {
  const run = async () => { throw new Error("must not run"); };
  const smoke = (o) => createKotlinSmokeRunner({ run, stopGradle: async () => {}, area: o.area, staging: o.staging })({ hash: o.hash ?? "abc12345", server: o.server ?? "production" });
  for (const hash of ["", "xyz", "abc 123", "abc12345 --evil", "ab", "abc'12345"]) {
    const r = await smoke({ hash });
    assert.equal(r.ok, false, hash);
    assert.match(r.detail, /bad api version hash/);
  }
  for (const area of ["Red Table", "Re'd", 'Re"d', "Re\nd", "Re`d", "Re$d", "Re\\d"]) {
    const r = await smoke({ area });
    assert.equal(r.ok, false, JSON.stringify(area));
    assert.match(r.detail, /area must not contain/);
  }
  for (const [k, v] of [["room", "https://x/ y"], ["pusherUrl", "https://p'"]]) {
    const r = await smoke({ server: "staging", staging: { room: "https://s/r", pusherUrl: "https://p", [k]: v } });
    assert.equal(r.ok, false, k);
  }
  assert.throws(() => kotlinSmokeInvocation({ hash: "abc12345", server: "production", name: "a b" }), /name must not/);
});

test("staging kotlin smoke without staging.room fails closed", async () => {
  let ran = false;
  const r = await createKotlinSmokeRunner({ run: async () => { ran = true; return { code: 0, output: "" }; } })({ hash: "abc12345", server: "staging" });
  assert.equal(r.ok, false);
  assert.match(r.detail, /staging needs staging\.room/);
  assert.equal(ran, false);
});

test("after a timeout the gradle daemon is stopped (injected)", async () => {
  const ac = new AbortController();
  let stopped = 0;
  const run = async () => { ac.abort(); return { code: null, output: "killed" }; };
  const r = await createKotlinSmokeRunner({ run, stopGradle: async () => { stopped++; } })({ hash: "abc12345", server: "production", signal: ac.signal });
  assert.equal(r.ok, false);
  assert.equal(stopped, 1);
});

test("a runner that resolves after its timeout is ignored", async () => {
  const late = () => new Promise((res) => setTimeout(() => res({ ok: true }), 100));
  const r = await gate({ runners: { ...allPass(), selfcheck: late }, timeouts: { selfcheck: 20 } });
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(r.steps[1].status, "fail");
  assert.match(r.steps[1].detail, /timed out/);
});

test("timeout kills the whole process tree, grandchild included", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tree-"));
  const pidFile = path.join(tmp, "grandchild.pid");
  const grand = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 1000)`;
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: 'ignore' }); setInterval(()=>{}, 1000)`;
  const ac = new AbortController();
  const p = runChild({ command: process.execPath, args: ["-e", parent], signal: ac.signal, graceMs: 100 });
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.doesNotThrow(() => process.kill(pid, 0), "grandchild is running before the abort");
  ac.abort();
  await p;
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, "grandchild is gone");
});

test("a child that ignores SIGTERM is SIGKILLed after the grace period", async () => {
  const ac = new AbortController();
  const p = runChild({ command: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], signal: ac.signal, graceMs: 100 });
  setTimeout(() => ac.abort(), 100);
  const r = await Promise.race([p, new Promise((res) => setTimeout(() => res("hung"), 5000))]);
  assert.notEqual(r, "hung");
});
