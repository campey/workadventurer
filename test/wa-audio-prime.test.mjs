// The connect-time mic prime: a single bounded silence burst, no perpetual
// stream. (werift<->werift ICE won't complete between two headless clients on
// one host, so a fake connected peer stands in.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WaAudio } from "../src/wa-audio.mjs";

function fakeClient() {
  const c = new EventEmitter();
  c.spaces = new Map([["s1", { spaceUserId: "u1" }]]);
  c.sent = [];
  c._send = (m) => c.sent.push(m);
  c.setSpaceMicState = () => {};
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
