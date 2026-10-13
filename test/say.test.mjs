// speak(): say.py (stubbed) -> ffmpeg Opus -> demuxed packets, and above all
// its teardown. Needs ffmpeg on PATH; skips itself if missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { speak } from "../src/say.mjs";

const hasFfmpeg = (() => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const FAKE = fileURLToPath(new URL("../scripts/fake-say.mjs", import.meta.url));
const base = { python: process.execPath, sayPath: FAKE };
const opts = { skip: !hasFfmpeg, timeout: 20000 };

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
}
const tmp = () => mkdtempSync(path.join(tmpdir(), "say-test-"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function collect(it) { const out = []; for await (const p of it) out.push(p); return out; }

test("1 s of tone becomes ~50 Opus packets of 960 samples", opts, async () => {
  const pk = await withEnv({ FAKE_SAY_SECONDS: "1" }, () => collect(speak("hello", base)));
  assert.ok(pk.length >= 48 && pk.length <= 53, `got ${pk.length} packets`);
  assert.ok(pk.every((p) => p.samples === 960));
});

test("text reaches say.py intact (quotes, $(), leading dash, newline, emoji)", opts, async () => {
  const dir = tmp();
  try {
    const nasty = `-rf "$(echo hi)" 'x'\nsecond line — émoji 🎙`;
    const file = path.join(dir, "stdin.txt");
    await withEnv({ FAKE_SAY_SECONDS: "0.2", FAKE_SAY_STDIN_FILE: file }, () => collect(speak(nasty, base)));
    assert.equal(readFileSync(file, "utf8"), nasty);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("say.py exiting non-zero surfaces its reason", opts, async () => {
  await withEnv({ FAKE_SAY_MODE: "fail" }, () =>
    assert.rejects(collect(speak("x", base)), /say\.py exited 3.*simulated failure/));
});

test("missing python or ffmpeg rejects with a spawn error and does not crash", opts, async () => {
  await assert.rejects(collect(speak("x", { ...base, python: "/nonexistent/python" })), /ENOENT/);
  await withEnv({ FAKE_SAY_SECONDS: "0.2" }, () =>
    assert.rejects(collect(speak("x", { ...base, ffmpegPath: "/nonexistent/ffmpeg" })), /ENOENT/));
});

test("abort during a cold start (no PCM yet) kills say.py and resolves quietly", opts, async () => {
  const dir = tmp();
  try {
    const pidFile = path.join(dir, "pid");
    const ac = new AbortController();
    const t0 = Date.now();
    const pk = await withEnv({ FAKE_SAY_MODE: "hang", FAKE_SAY_PID_FILE: pidFile }, async () => {
      setTimeout(() => ac.abort(), 300);
      return collect(speak("x", { ...base, signal: ac.signal }));
    });
    assert.deepEqual(pk, []);
    assert.ok(Date.now() - t0 < 5000, "returned promptly");
    assert.ok(existsSync(pidFile), "stub actually started");
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "say.py is gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ffmpeg exiting early tears down say.py and reports ffmpeg's failure instead of hanging",
  { ...opts, skip: !hasFfmpeg || !existsSync("/usr/bin/false") }, async () => {
  const t0 = Date.now();
  await withEnv({ FAKE_SAY_SECONDS: "30" }, () =>
    assert.rejects(collect(speak("x", { ...base, ffmpegPath: "/usr/bin/false" })), /ffmpeg exited 1/));
  assert.ok(Date.now() - t0 < 8000, "did not wait for the 30 s clip");
});

test("consumer stopping early (return()) tears everything down", opts, async () => {
  const dir = tmp();
  try {
    const pidFile = path.join(dir, "pid");
    const t0 = Date.now();
    await withEnv({ FAKE_SAY_SECONDS: "30", FAKE_SAY_PID_FILE: pidFile }, async () => {
      let n = 0;
      for await (const _ of speak("x", base)) if (++n === 3) break;
    });
    assert.ok(Date.now() - t0 < 5000, "did not wait for the 30 s clip");
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "say.py is gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
