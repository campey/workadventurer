// The connect-time mic prime: a single bounded silence burst, no perpetual
// stream. (werift<->werift ICE won't complete between two headless clients on
// one host, so a fake connected peer stands in.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WaAudio } from "../src/wa-audio.mjs";

function fakeClient({ micOn = true } = {}) {
  const c = new EventEmitter();
  c.micOn = micOn;
  c.spaces = new Map([["s1", { spaceUserId: "u1" }]]);
  c.sent = [];
  c.micStateCalls = [];
  c._send = (m) => c.sent.push(m);
  c.setSpaceMicState = (spaceName, on) => c.micStateCalls.push({ spaceName, on });
  c.query = async () => ({ iceServersAnswer: { iceServers: [] } });
  c.adapter = {
    micState: { speakingMaskPaths: ["showVoiceIndicator", "microphoneState"] },
  };
  return c;
}

function fakePeer(state = "connected") {
  const rtp = [];
  return {
    pc: { connectionState: state, close() {} },
    track: { writeRtp: (pkt) => rtp.push(pkt) },
    spaceName: "s1",
    remoteUserId: "peer-1",
    ssrc: 1,
    seq: 0,
    ts: 0,
    lastPlayEnd: performance.now(),
    _rtp: rtp,
  };
}

test("_primeMic sends one bounded silence burst then stops", async () => {
  const audio = new WaAudio(fakeClient());
  const p = fakePeer();
  audio.peers.set("p1", p);

  await audio._primeMic();

  assert.ok(p._rtp.length >= 15 && p._rtp.length <= 30, `~21 frames for 0.4 s, got ${p._rtp.length}`);
  assert.equal(audio._play, null, "playback guard released — nothing left running");

  // no more packets after it returns
  const n = p._rtp.length;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(p._rtp.length, n, "no perpetual stream");

  // first frame carries the talkspurt marker; mic-on asserted without the ring
  assert.equal(p._rtp[0].header.marker, true);
  const spk = audio.client.sent.filter((m) => m.updateSpaceUserMessage);
  assert.ok(spk.length >= 1);
  assert.equal(
    spk.every((m) => m.updateSpaceUserMessage.user.showVoiceIndicator === false),
    true,
    "prime never lights the speaking indicator"
  );
  assert.equal(
    spk.every((m) => m.updateSpaceUserMessage.user.microphoneState === true),
    true,
    "prime re-asserts mic-on"
  );
});

test("_primeMic is a no-op with no connected peer", async () => {
  const audio = new WaAudio(fakeClient());
  audio.peers.set("p1", fakePeer("connecting"));
  await audio._primeMic();
  assert.equal(audio._play, null);
});

test("_primeMic yields to a clip that's already playing", async () => {
  const audio = new WaAudio(fakeClient());
  const p = fakePeer();
  audio.peers.set("p1", p);
  audio._play = { stop() {} }; // pretend a real clip is mid-flight
  await audio._primeMic();
  assert.equal(p._rtp.length, 0, "prime did not touch the wire");
});

// #10: microphoneState must always mirror client.micOn — never hardcoded true.
// Otherwise a listen-mode instance advertises mic-on it never intended.
test("_setSpeaking mirrors client.micOn, on or off", () => {
  const onClient = fakeClient({ micOn: true });
  new WaAudio(onClient)._setSpeaking(true, false);
  const onMsgs = onClient.sent.filter((m) => m.updateSpaceUserMessage);
  assert.ok(onMsgs.length >= 1);
  assert.equal(onMsgs.every((m) => m.updateSpaceUserMessage.user.microphoneState === true), true);

  const offClient = fakeClient({ micOn: false });
  new WaAudio(offClient)._setSpeaking(true, false);
  const offMsgs = offClient.sent.filter((m) => m.updateSpaceUserMessage);
  assert.ok(offMsgs.length >= 1);
  assert.equal(offMsgs.every((m) => m.updateSpaceUserMessage.user.microphoneState === false), true);
});

// #10: two failed prime attempts must fall back to an honest mic-off, never
// leave the mic claimed-on with nothing ever sent.
test("_primeMic retries once, then reports mic off after repeated failure", async () => {
  const client = fakeClient();
  const audio = new WaAudio(client);
  audio.peers.set("p1", fakePeer());
  audio._silencePath = "/dev/null/not-a-real-clip.ogg"; // skip real silenceOpusFile() for attempt 1

  let calls = 0;
  audio.play = async () => {
    calls++;
    return { played: false, reason: "boom" };
  };

  await audio._primeMic();

  assert.equal(calls, 2, "exactly one retry after the first failure");
  assert.ok(client.micStateCalls.length >= 1, "falls back via client.setSpaceMicState");
  assert.equal(
    client.micStateCalls.every((c) => c.on === false),
    true,
    "honest mic-off, not a silent claimed-on"
  );
});

// #10 (d): a real clip landing mid-prime must not be truncated by the prime,
// nor vice versa — whichever call runs second sees the guard immediately,
// before any await, not after racing past it.
test("play() claims its in-flight guard synchronously, before any await", async () => {
  const { silenceOpusFile } = await import("../src/transcode.mjs");
  const clipA = await silenceOpusFile(1.5); // distinct cache entry from clipB
  const clipB = await silenceOpusFile(0.4);

  const audio = new WaAudio(fakeClient());
  const p = fakePeer();
  audio.peers.set("p1", p);

  // Two calls back-to-back, neither awaited before the other starts — this is
  // the actual race (two peers connecting a few ms apart, or a real clip
  // landing mid-prime). The guard must already be claimed synchronously, at
  // function entry, not after `ensureOpus`/`readOggOpus`'s awaits (#10).
  const first = audio.play(clipA);
  assert.ok(audio._play, "first call claimed the guard before its own awaits resolved");
  const second = audio.play(clipB);

  const [r1, r2] = await Promise.all([first, second]);
  // The first was stopped by the second superseding it; exactly one of them
  // actually finishes cleanly — no shared/corrupted `_play` state left behind.
  assert.equal(r1.played, false);
  assert.equal(r1.reason, "superseded");
  assert.equal(r2.played, true);
  assert.equal(audio._play, null, "guard released — nothing left dangling");
});
