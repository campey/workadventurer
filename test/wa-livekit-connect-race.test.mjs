// #8 follow-up: a named area (e.g. a "fire pit") escalates straight to
// LiveKit with no WEBRTC phase at all. `_connectLiveKit()` only sets
// `this._livekit` after `room.connect()` + `publishTrack()` both resolve,
// which can take a while for a real SFU. `/sound` checked `audio.connected`
// synchronously with no awareness of that in-flight connect, so a chime
// fired right after joining raced it and 409'd with "no one in the bubble
// to hear it" -- even though someone was already in the room. Leaving and
// rejoining "fixed" it only because the first connect had finished quietly
// in the background by the second attempt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WaAudio } from "../src/wa-audio.mjs";

function fakeClient() {
  const c = new EventEmitter();
  c.micOn = true;
  c.spaces = new Map([["s1", { spaceUserId: "u1" }]]);
  c.sent = [];
  c._send = (m) => c.sent.push(m);
  c.setSpaceMicState = () => {};
  c.query = async () => ({ iceServersAnswer: { iceServers: [] } });
  c.adapter = { micState: { speakingMaskPaths: ["showVoiceIndicator", "microphoneState"] } };
  return c;
}

test("waitForLiveKit resolves once an in-flight connect settles, not before", async () => {
  const audio = new WaAudio(fakeClient());
  let resolveConnect;
  audio._livekitConnecting = new Promise((r) => (resolveConnect = r));

  assert.equal(audio.connected, false, "not connected while the SFU connect is still in flight");

  const waited = audio.waitForLiveKit(1000);
  let settled = false;
  waited.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, "waitForLiveKit must not resolve before the connect promise does");

  audio._livekit = { room: { remoteParticipants: new Map([["x", {}]]) } };
  resolveConnect();
  await waited;
  assert.equal(audio.connected, true, "connected reflects the now-completed LiveKit connection");
});

test("waitForLiveKit is a no-op when nothing is connecting", async () => {
  const audio = new WaAudio(fakeClient());
  const start = Date.now();
  await audio.waitForLiveKit(1000);
  assert.ok(Date.now() - start < 100, "returns immediately -- nothing to wait for");
});

test("waitForLiveKit gives up after its timeout if the connect never settles", async () => {
  const audio = new WaAudio(fakeClient());
  audio._livekitConnecting = new Promise(() => {}); // never resolves
  const start = Date.now();
  await audio.waitForLiveKit(50);
  assert.ok(Date.now() - start < 500, "bounded by the timeout, not stuck forever");
});

test("waitForLiveKit swallows a failed connect instead of throwing", async () => {
  const audio = new WaAudio(fakeClient());
  audio._livekitConnecting = Promise.reject(new Error("SFU unreachable"));
  await assert.doesNotReject(() => audio.waitForLiveKit(1000));
});
