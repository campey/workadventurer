// WaAudio.say() on a LiveKit-escalated meeting: stubbed say.py, a fake
// AudioSource. Needs ffmpeg; skips itself if missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WaAudio } from "../src/wa-audio.mjs";

const hasFfmpeg = (() => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const FAKE = fileURLToPath(new URL("../scripts/fake-say.mjs", import.meta.url));
const opts = { skip: !hasFfmpeg, timeout: 30000 };

function fakeClient() {
  const c = new EventEmitter();
  c.micOn = true;
  c.spaces = new Map([["s1", { spaceUserId: "u1" }]]);
  c.sent = [];
  c._send = (m) => c.sent.push(m);
  c.query = async () => ({ iceServersAnswer: { iceServers: [] } });
  c.adapter = { micState: { speakingMaskPaths: ["showVoiceIndicator", "microphoneState"] } };
  return c;
}

// `paceMs`: how long captureFrame takes (0 = instant). `playoutMs`: how long
// waitForPlayout takes unless clearQueue() ends it early.
function fakeSource({ paceMs = 0, playoutMs = 0 } = {}) {
  const s = { frames: [], cleared: 0, playoutWaits: 0, _release: null };
  s.captureFrame = async (f) => { if (paceMs) await sleep(paceMs); s.frames.push(f); };
  s.waitForPlayout = () => {
    s.playoutWaits++;
    return new Promise((resolve) => {
      s._release = resolve;
      setTimeout(resolve, playoutMs);
    });
  };
  s.clearQueue = () => { s.cleared++; s._release?.(); };
  return s;
}

function setup(sourceOpts) {
  const audio = new WaAudio(fakeClient(), { tts: { python: process.execPath, sayPath: FAKE } });
  const source = fakeSource(sourceOpts);
  audio._livekit = {
    room: { remoteParticipants: new Map([["p1", {}]]), disconnect: async () => {} },
    source,
    track: { close: async () => {} },
  };
  return { audio, source };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
}
const speaking = (client) =>
  client.sent.filter((m) => m.updateSpaceUserMessage).map((m) => m.updateSpaceUserMessage.user.showVoiceIndicator);

test("say over LiveKit feeds ~1 s of 48 kHz frames to captureFrame, waits for playout, reports timings", opts, async () => {
  const { audio, source } = setup();
  const r = await withEnv({ FAKE_SAY_SECONDS: "1" }, () => audio.say("hello"));
  assert.equal(r.played, true);
  assert.equal(r.transport, "livekit");
  assert.equal(r.peers, 1);
  assert.ok(source.frames.length >= 49 && source.frames.length <= 52, `frames ${source.frames.length}`);
  const f = source.frames[10];
  assert.equal(f.sampleRate, 48000);
  assert.equal(f.channels, 1);
  assert.equal(f.samplesPerChannel, 960);
  assert.equal(source.playoutWaits, 1, "waited for the queued audio to finish playing");
  assert.ok(r.firstAudioMs > 0 && r.firstRtpMs >= r.firstAudioMs, `${r.firstAudioMs} / ${r.firstRtpMs}`);
  assert.deepEqual(speaking(audio.client), [true, false]);
  assert.equal(audio._play, null);
});

test("hangup mid-sentence stops feeding frames, flushes the queue, and clears the indicator", opts, async () => {
  const { audio, source } = setup({ paceMs: 20 });
  const p = withEnv({ FAKE_SAY_SECONDS: "5" }, () => audio.say("long"));
  await sleep(700);
  const t0 = Date.now();
  audio.hangup("test");
  const r = await p;
  assert.equal(r.played, false);
  assert.ok(Date.now() - t0 < 3000, "stopped promptly");
  assert.ok(source.cleared >= 1, "queued audio was flushed");
  assert.ok(source.frames.length < 200, "did not keep feeding after the stop");
  assert.equal(source.playoutWaits, 0);
  assert.equal(speaking(audio.client).at(-1), false);
  assert.equal(audio._play, null);
});

test("stopSay while the tail is still playing out cancels it at once (clearQueue ends the wait)", opts, async () => {
  const { audio, source } = setup({ playoutMs: 20_000 });
  const p = withEnv({ FAKE_SAY_SECONDS: "0.5" }, () => audio.say("short"));
  await sleep(1500); // all frames queued, now blocked in waitForPlayout
  assert.equal(source.playoutWaits, 1);
  const t0 = Date.now();
  assert.equal(audio.stopSay(), true);
  const r = await p;
  assert.ok(Date.now() - t0 < 2000, "did not wait out the 20 s playout");
  assert.equal(r.played, false);
  assert.ok(source.cleared >= 1);
  assert.equal(speaking(audio.client).at(-1), false);
});

test("a new say supersedes one in flight on LiveKit", opts, async () => {
  const { audio, source } = setup({ paceMs: 20 });
  const first = withEnv({ FAKE_SAY_SECONDS: "5" }, () => audio.say("one"));
  await sleep(700);
  const second = await withEnv({ FAKE_SAY_SECONDS: "0.5" }, () => audio.say("two"));
  assert.equal((await first).played, false);
  assert.equal(second.played, true);
  assert.ok(source.cleared >= 1);
  assert.equal(audio._play, null);
});

test("say.py failure on LiveKit resolves played:false with the reason and never lights the indicator", opts, async () => {
  const { audio, source } = setup();
  const r = await withEnv({ FAKE_SAY_MODE: "fail" }, () => audio.say("x"));
  assert.equal(r.played, false);
  assert.match(r.reason, /say\.py exited 3/);
  assert.equal(speaking(audio.client).includes(true), false);
  assert.equal(source.frames.length, 0);
  assert.equal(audio._play, null);
});

test("captureFrame errors are counted, not thrown", opts, async () => {
  const { audio, source } = setup();
  source.captureFrame = async () => { throw new Error("closed"); };
  const r = await withEnv({ FAKE_SAY_SECONDS: "0.2" }, () => audio.say("x"));
  assert.equal(r.played, false);
  assert.ok(r.writeErrors > 0);
  assert.equal(speaking(audio.client).at(-1), false);
});
