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
  assert.match(a, /--walk-to-area 'Red Table'/);
  assert.doesNotMatch(a, /--room/);
  const s = kotlinSmokeInvocation({ hash: "d2d82672", server: "staging", staging: { room: "https://s/r", pusherUrl: "https://p" } });
  assert.match(s.args.find((x) => x.startsWith("--args=")), /--room https:\/\/s\/r --pusher https:\/\/p/);
});

test("child runners decide on exit code and, for the smoke, on arrival", async () => {
  const okRun = (output, code = 0) => async () => ({ code, output });
  assert.equal((await createSelfcheckRunner({ run: okRun("OK") })({ candidateFile: "/c", server: "production" })).ok, true);
  const bad = await createSelfcheckRunner({ run: okRun("PASS a\nFAIL  move  — stuck\n\nFAIL", 1) })({ candidateFile: "/c", server: "production" });
  assert.deepEqual([bad.ok, bad.detail], [false, "FAIL  move  — stuck"]);
  const smoke = (o, c) => createKotlinSmokeRunner({ run: okRun(o, c) })({ hash: "h", server: "production" });
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
