// _pump: the shared RTP pacing loop behind both file playback and `wa say`.
// Real timers with generous tolerances (a fake clock would not exercise
// performance.now()/sleep the way production does).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { WaAudio } from "../src/wa-audio.mjs";

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

function fakePeer(onWrite) {
  const rtp = [];
  return {
    pc: { connectionState: "connected", close() {} },
    track: { writeRtp: (pkt) => { rtp.push(pkt); onWrite?.(rtp.length); } },
    spaceName: "s1", remoteUserId: "peer-1", ssrc: 1, seq: 0, ts: 0,
    lastPlayEnd: performance.now(),
    _rtp: rtp,
  };
}

const pkt = (i) => ({ data: Buffer.from([0x78, i & 0xff]), samples: 960 });
const speaking = (client) =>
  client.sent.filter((m) => m.updateSpaceUserMessage).map((m) => m.updateSpaceUserMessage.user.showVoiceIndicator);

test("file-style array: all packets, marker on the first only, contiguous timestamps, ~20 ms pacing", async () => {
  const audio = new WaAudio(fakeClient());
  const peer = fakePeer();
  const t0 = performance.now();
  const r = await audio._pump(Array.from({ length: 10 }, (_, i) => pkt(i)), {
    getTargets: () => [peer], isStopped: () => false,
  });
  const took = performance.now() - t0;
  assert.equal(r.packetsSent, 10);
  assert.equal(peer._rtp.length, 10);
  assert.deepEqual(peer._rtp.map((p) => p.header.marker), [true, ...Array(9).fill(false)]);
  for (let i = 1; i < 10; i++) {
    assert.equal(peer._rtp[i].header.timestamp - peer._rtp[i - 1].header.timestamp, 960);
  }
  assert.ok(took > 150 && took < 600, `10 x 20 ms paced in ${took.toFixed(0)} ms`);
  assert.deepEqual(speaking(audio.client), [true, false]);
});

test("prebuffer holds the first RTP packet until N packets have been pulled", async () => {
  async function* gen(state) {
    for (let i = 0; i < 10; i++) { await sleep(5); state.pulled++; yield pkt(i); }
  }
  const run = async (prebuffer) => {
    const state = { pulled: 0 };
    let pulledAtFirstWrite = null;
    const peer = fakePeer((n) => { if (n === 1) pulledAtFirstWrite = state.pulled; });
    const audio = new WaAudio(fakeClient());
    await audio._pump(gen(state), { getTargets: () => [peer], isStopped: () => false, prebuffer });
    return pulledAtFirstWrite;
  };
  assert.ok((await run(5)) >= 5, "prebuffer 5");
  assert.equal(await run(0), 1, "control: no prebuffer sends as soon as the first arrives");
});

test("a stream shorter than the prebuffer still flushes at end", async () => {
  const audio = new WaAudio(fakeClient());
  const peer = fakePeer();
  const r = await audio._pump((async function* () { for (let i = 0; i < 3; i++) yield pkt(i); })(), {
    getTargets: () => [peer], isStopped: () => false, prebuffer: 25,
  });
  assert.equal(r.packetsSent, 3);
});

test("an underrun starts a new talkspurt: marker set and RTP timestamp jumps over the gap", async () => {
  async function* gen() {
    for (let i = 0; i < 5; i++) yield pkt(i);
    await sleep(250); // producer stalls
    for (let i = 5; i < 10; i++) yield pkt(i);
  }
  const audio = new WaAudio(fakeClient());
  const peer = fakePeer();
  await audio._pump(gen(), { getTargets: () => [peer], isStopped: () => false, prebuffer: 2 });
  const markers = peer._rtp.map((p) => p.header.marker);
  assert.equal(markers[0], true);
  assert.equal(markers[5], true, "first packet after the stall is a new talkspurt");
  assert.equal(markers.filter(Boolean).length, 2, "no other markers");
  const jump = peer._rtp[5].header.timestamp - peer._rtp[4].header.timestamp;
  assert.ok(jump > 960 + 48000 * 0.1, `timestamp advanced over the stall (${jump})`);
});

test("stop mid-stream: ends promptly, releases the source, and clears the speaking indicator last", async () => {
  let sourceClosed = false;
  async function* gen() {
    try { for (let i = 0; i < 1000; i++) yield pkt(i); } finally { sourceClosed = true; }
  }
  let stopped = false;
  const peer = fakePeer((n) => { if (n === 3) stopped = true; });
  const audio = new WaAudio(fakeClient());
  const r = await audio._pump(gen(), { getTargets: () => [peer], isStopped: () => stopped });
  assert.ok(r.packetsSent >= 3 && r.packetsSent <= 4, `sent ${r.packetsSent}`);
  assert.equal(sourceClosed, true, "producer's finally ran (this is what kills say.py)");
  assert.deepEqual(speaking(audio.client), [true, false]);
});

test("no connected peers once audio arrives: reports it and never lights the indicator", async () => {
  const audio = new WaAudio(fakeClient());
  const r = await audio._pump([pkt(0), pkt(1)], { getTargets: () => [], isStopped: () => false });
  assert.equal(r.packetsSent, 0);
  assert.equal(r.reason, "no connected peers");
  assert.deepEqual(speaking(audio.client), []);
});

test("an empty source reports 'empty' without lighting the indicator", async () => {
  const audio = new WaAudio(fakeClient());
  const r = await audio._pump([], { getTargets: () => [fakePeer()], isStopped: () => false });
  assert.equal(r.reason, "empty");
  assert.deepEqual(speaking(audio.client), []);
});
