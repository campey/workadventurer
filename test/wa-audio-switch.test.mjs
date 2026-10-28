// Strategy-switch messages (#150). Observed live on prod wa-1.34: after a
// LiveKit -> WEBRTC de-escalation the server sends
//   switchMessage{WEBRTC} + webRtcStart   (the mesh restarts)
//   finalizeSwitchMessage{LIVEKIT}        (the LiveKit side being shut down)
// finalizeSwitchMessage names the transport being retired, not the one being
// switched to, so it must never tear down the freshly started mesh peers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WaAudio } from "../src/wa-audio.mjs";

function fakeClient() {
  const c = new EventEmitter();
  c.micOn = true;
  c.spaces = new Map();
  c._send = () => {};
  c.query = async () => ({ iceServersAnswer: { iceServers: [] } });
  c.adapter = {
    micState: { speakingMaskPaths: ["showVoiceIndicator", "microphoneState"] },
    meeting: { webrtcStrategyName: "WEBRTC", livekitStrategyName: "LIVEKIT" },
  };
  return c;
}

function audioWithMeshPeer() {
  const audio = new WaAudio(fakeClient());
  let closed = false;
  audio.peers.set("p1", {
    pc: { connectionState: "connected", close() { closed = true; } },
    track: { writeRtp() {} },
    spaceName: "s1", remoteUserId: "peer-1", ssrc: 1, seq: 0, ts: 0,
    lastPlayEnd: performance.now(),
  });
  return { audio, wasClosed: () => closed };
}

const ev = (kind, strategy) => ({ spaceName: "s1", senderUserId: "u", kind, payload: { strategy } });

test("finalizeSwitchMessage{LIVEKIT} after a de-escalation leaves the new mesh peers alone", () => {
  const { audio, wasClosed } = audioWithMeshPeer();
  audio._onSpaceEvent(ev("finalizeSwitchMessage", "LIVEKIT"));
  assert.equal(wasClosed(), false, "mesh peer was hung up");
  assert.equal(audio.peers.size, 1);
});

test("finalizeSwitchMessage{WEBRTC} after an escalation is harmless too", () => {
  const { audio, wasClosed } = audioWithMeshPeer();
  audio._onSpaceEvent(ev("finalizeSwitchMessage", "WEBRTC"));
  assert.equal(wasClosed(), false);
});

test("switchMessage{LIVEKIT} (an escalation) still idles the mesh", () => {
  const { audio, wasClosed } = audioWithMeshPeer();
  audio._onSpaceEvent(ev("switchMessage", "LIVEKIT"));
  assert.equal(wasClosed(), true, "escalation must still close the mesh peers");
  assert.equal(audio.peers.size, 0);
});

test("switchMessage{WEBRTC} (a de-escalation) does not touch the mesh", () => {
  const { audio, wasClosed } = audioWithMeshPeer();
  audio._onSpaceEvent(ev("switchMessage", "WEBRTC"));
  assert.equal(wasClosed(), false);
});

test("switchMessage{WEBRTC} while on LiveKit (a de-escalation) drops the stale LiveKit connection so play() routes to the mesh", async () => {
  // Observed live: the server sends no livekitDisconnectMessage on a
  // de-escalation, so without this the avatar sits on both transports and
  // play()/say() publish into a LiveKit room nobody is listening to.
  const { audio, wasClosed } = audioWithMeshPeer();
  let roomDisconnected = false;
  audio._livekit = {
    room: { remoteParticipants: new Map(), disconnect: async () => { roomDisconnected = true; } },
    source: {},
    track: { close: async () => {} },
  };
  audio._onSpaceEvent(ev("switchMessage", "WEBRTC"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(audio._livekit, null, "LiveKit connection should be gone");
  assert.equal(roomDisconnected, true);
  assert.equal(wasClosed(), false, "the mesh peer must survive");
  let route = null;
  audio._playWebrtc = async () => { route = "webrtc"; return {}; };
  audio._playLiveKit = async () => { route = "livekit"; return {}; };
  await audio.play("x.ogg");
  assert.equal(route, "webrtc");
});
