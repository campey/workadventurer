// WaAudio.say(): the whole chain with a stubbed say.py and a fake peer. Needs
// ffmpeg; skips itself if missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
function fakePeer() {
  const rtp = [];
  return {
    pc: { connectionState: "connected", close() {} },
    track: { writeRtp: (pkt) => rtp.push(pkt) },
    spaceName: "s1", remoteUserId: "peer-1", ssrc: 1, seq: 0, ts: 0,
    lastPlayEnd: performance.now(),
    _rtp: rtp,
  };
}
function setup() {
  const audio = new WaAudio(fakeClient(), { tts: { python: process.execPath, sayPath: FAKE } });
  const peer = fakePeer();
  audio.peers.set("p1", peer);
  return { audio, peer };
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

test("say streams ~1 s of speech as RTP and reports timings", opts, async () => {
  const { audio, peer } = setup();
  const r = await withEnv({ FAKE_SAY_SECONDS: "1" }, () => audio.say("hello"));
  assert.equal(r.played, true);
  assert.equal(r.transport, "webrtc");
  assert.ok(peer._rtp.length >= 48 && peer._rtp.length <= 53, `rtp ${peer._rtp.length}`);
  assert.equal(peer._rtp[0].header.marker, true);
  assert.ok(r.firstAudioMs > 0 && r.firstRtpMs >= r.firstAudioMs, `${r.firstAudioMs} / ${r.firstRtpMs}`);
  assert.deepEqual(speaking(audio.client), [true, false]);
  assert.equal(audio._play, null);
});

test("a new say supersedes the one in flight", opts, async () => {
  const { audio } = setup();
  const first = withEnv({ FAKE_SAY_SECONDS: "5" }, () => audio.say("one"));
  await sleep(900); // past the 500 ms prebuffer, so the first is really playing
  const second = await withEnv({ FAKE_SAY_SECONDS: "0.5" }, () => audio.say("two"));
  const r1 = await first;
  assert.equal(r1.played, false);
  assert.equal(second.played, true);
  assert.equal(audio._play, null);
});

test("hangup mid-sentence stops speech promptly and releases the guard", opts, async () => {
  const { audio } = setup();
  const p = withEnv({ FAKE_SAY_SECONDS: "5" }, () => audio.say("long"));
  await sleep(900);
  const t0 = Date.now();
  audio.hangup("test");
  const r = await p;
  assert.equal(r.played, false);
  assert.ok(Date.now() - t0 < 3000, "stopped promptly");
  assert.equal(audio._play, null);
  assert.equal(speaking(audio.client).at(-1), false);
});

test("stopSay stops a say but not a clip, and reports which", opts, async () => {
  const { audio } = setup();
  assert.equal(audio.stopSay(), false, "nothing to stop");
  const p = withEnv({ FAKE_SAY_SECONDS: "5" }, () => audio.say("long"));
  await sleep(900);
  assert.equal(audio.stopSay(), true);
  assert.equal((await p).played, false);
  audio._play = { kind: "clip", stop() { throw new Error("must not be called"); } };
  assert.equal(audio.stopSay(), false, "a clip is left alone");
  audio._play = null;
});

test("no connected peers: returns the reason and never starts say.py", opts, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "say-audio-"));
  try {
    const pidFile = path.join(dir, "pid");
    const audio = new WaAudio(fakeClient(), { tts: { python: process.execPath, sayPath: FAKE } });
    const r = await withEnv({ FAKE_SAY_PID_FILE: pidFile }, () => audio.say("anyone?"));
    assert.equal(r.played, false);
    assert.equal(r.reason, "no connected peers");
    assert.equal(existsSync(pidFile), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("say.py failure resolves played:false with the reason and never lights the indicator", opts, async () => {
  const { audio } = setup();
  const r = await withEnv({ FAKE_SAY_MODE: "fail" }, () => audio.say("x"));
  assert.equal(r.played, false);
  assert.match(r.reason, /say\.py exited 3/);
  assert.deepEqual(speaking(audio.client), []);
  assert.equal(audio._play, null);
});

test("on a LiveKit-escalated meeting say reports it is not built yet (slice 1)", opts, async () => {
  const { audio } = setup();
  audio._livekit = {};
  const r = await audio.say("x");
  assert.equal(r.played, false);
  assert.match(r.reason, /livekit/i);
});
