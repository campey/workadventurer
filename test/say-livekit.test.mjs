// speakLiveKit(): say.py (stubbed) -> ffmpeg resample 24 -> 48 kHz -> 20 ms
// Int16Array frames for AudioSource.captureFrame. Needs ffmpeg on PATH; skips
// itself if missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { speakLiveKit } from "../src/say.mjs";

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
const tmp = () => mkdtempSync(path.join(tmpdir(), "say-lk-test-"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function collect(it) { const out = []; for await (const f of it) out.push(f); return out; }
const rms = (f) => Math.sqrt(f.reduce((s, v) => s + v * v, 0) / f.length);

test("1 s of tone becomes ~50 frames of 960 samples (20 ms at 48 kHz)", opts, async () => {
  const frames = await withEnv({ FAKE_SAY_SECONDS: "1" }, () => collect(speakLiveKit("hello", base)));
  assert.ok(frames.length >= 49 && frames.length <= 52, `got ${frames.length} frames`);
  assert.ok(frames.every((f) => f instanceof Int16Array && f.length === 960));
  const mid = frames.slice(5, 45);
  assert.ok(mid.every((f) => rms(f) > 1000), "the tone survived the resample at a sane level");
});

test("every frame owns a zero-offset buffer and the frames differ (the .subarray() buzz bug)", opts, async () => {
  const frames = await withEnv({ FAKE_SAY_SECONDS: "0.5" }, () => collect(speakLiveKit("hello", base)));
  for (const f of frames) {
    assert.equal(f.byteOffset, 0, "a view into a shared buffer would repeat the first frame");
    assert.equal(f.buffer.byteLength, 1920, "its own buffer, exactly one frame long");
  }
  // AudioFrame.protoInfo() reads `.buffer` from byte 0, ignoring byteOffset:
  // reading it that way must reproduce each frame, and consecutive frames of a
  // sine are different 20 ms slices.
  assert.deepEqual([...new Int16Array(frames[3].buffer)], [...frames[3]]);
  assert.notDeepEqual([...frames[3]], [...frames[4]]);
});

test("a trailing partial frame is zero-padded, not dropped", opts, async () => {
  // 0.51 s = 25.5 frames at 20 ms
  const frames = await withEnv({ FAKE_SAY_SECONDS: "0.51" }, () => collect(speakLiveKit("hello", base)));
  assert.ok(frames.length >= 25 && frames.length <= 27, `got ${frames.length}`);
  const last = frames[frames.length - 1];
  assert.equal(last.length, 960);
  assert.ok([...last.slice(-100)].every((v) => v === 0), "padding at the end of the last frame");
});

test("say.py exiting non-zero surfaces its reason", opts, async () => {
  await withEnv({ FAKE_SAY_MODE: "fail" }, () =>
    assert.rejects(collect(speakLiveKit("x", base)), /say\.py exited 3.*simulated failure/));
});

test("missing python rejects with a spawn error", opts, async () => {
  await assert.rejects(collect(speakLiveKit("x", { ...base, python: "/nonexistent/python" })), /ENOENT/);
});

test("ffmpeg exiting early tears down say.py and reports ffmpeg's failure",
  { ...opts, skip: !hasFfmpeg || !existsSync("/usr/bin/false") }, async () => {
  const t0 = Date.now();
  await withEnv({ FAKE_SAY_SECONDS: "30" }, () =>
    assert.rejects(collect(speakLiveKit("x", { ...base, ffmpegPath: "/usr/bin/false" })), /ffmpeg exited 1/));
  assert.ok(Date.now() - t0 < 8000);
});

test("abort during a cold start kills say.py and resolves quietly", opts, async () => {
  const dir = tmp();
  try {
    const pidFile = path.join(dir, "pid");
    const ac = new AbortController();
    const frames = await withEnv({ FAKE_SAY_MODE: "hang", FAKE_SAY_PID_FILE: pidFile }, async () => {
      setTimeout(() => ac.abort(), 300);
      return collect(speakLiveKit("x", { ...base, signal: ac.signal }));
    });
    assert.deepEqual(frames, []);
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "say.py is gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("consumer stopping early tears everything down", opts, async () => {
  const dir = tmp();
  try {
    const pidFile = path.join(dir, "pid");
    const t0 = Date.now();
    await withEnv({ FAKE_SAY_SECONDS: "30", FAKE_SAY_PID_FILE: pidFile }, async () => {
      let n = 0;
      for await (const _ of speakLiveKit("x", base)) if (++n === 3) break;
    });
    assert.ok(Date.now() - t0 < 5000, "did not wait for the 30 s clip");
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "say.py is gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
