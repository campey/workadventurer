// #32: 3+ simultaneous peers can misnegotiate. Root cause — a peer built
// before the real ICE-server list arrives gets werift's constructor-default
// STUN-only list, permanently (werift snapshots it at construction and never
// re-reads it). The live-timing/network parts of the fix (waiting on
// `_iceReady` before constructing an RTCPeerConnection) are verified live,
// not here — see docs/field-notes.md. These tests cover the pure parts: the
// SDP candidate-counting helper, and the closed-connectionId guard that stops
// a late signal from resurrecting a torn-down connection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WaAudio, candidateCount } from "../src/wa-audio.mjs";

function fakeClient() {
  const c = new EventEmitter();
  c.micOn = true;
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

test("candidateCount counts a=candidate: lines", () => {
  const sdp = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=candidate:1 1 udp 2130706431 10.0.0.1 5000 typ host",
    "a=candidate:2 1 udp 1694498815 203.0.113.1 5000 typ srflx",
    "a=mid:0",
  ].join("\r\n");
  assert.equal(candidateCount(sdp), 2);
});

test("candidateCount is zero for an SDP with no candidates — the #32 failure shape", () => {
  const sdp = ["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0"].join("\r\n");
  assert.equal(candidateCount(sdp), 0);
});

test("candidateCount only matches full candidate lines, not substrings elsewhere", () => {
  const sdp = ["v=0", "a=fingerprint:sha-256 not-a-candidate:xyz", "a=mid:0"].join("\r\n");
  assert.equal(candidateCount(sdp), 0);
});

test("_onSignal drops a signal for an already-closed connectionId without touching _peer", async () => {
  const audio = new WaAudio(fakeClient());
  let peerCalls = 0;
  audio._peer = () => {
    peerCalls++;
    return Promise.resolve({ pc: {} });
  };
  audio._closedConnIds.add("dead-conn");

  await audio._onSignal("s1", "peer-1", "dead-conn", JSON.stringify({ type: "candidate", candidate: {} }));

  assert.equal(peerCalls, 0, "a closed connectionId is dropped before ever calling _peer()");
});

test("_onSignal proceeds normally for a connectionId that was never closed", async () => {
  const audio = new WaAudio(fakeClient());
  let peerCalls = 0;
  audio._peer = () => {
    peerCalls++;
    // no candidate signal -> _onSignal's candidate branch, harmless no-op pc
    return Promise.resolve({ pc: { addIceCandidate: async () => {} } });
  };

  await audio._onSignal("s1", "peer-1", "fresh-conn", JSON.stringify({ type: "candidate", candidate: {} }));

  assert.equal(peerCalls, 1, "a live connectionId reaches _peer() as normal");
});

test("_closePeer marks a connectionId closed even if it never finished building", () => {
  const audio = new WaAudio(fakeClient());
  assert.equal(audio._closedConnIds.has("never-built"), false);
  audio._closePeer("never-built", "test");
  assert.equal(audio._closedConnIds.has("never-built"), true);
});

test("_closePeer's closed-id set is bounded and evicts the oldest entry", () => {
  const audio = new WaAudio(fakeClient());
  for (let i = 0; i < 70; i++) audio._closePeer(`c${i}`, "test");
  assert.equal(audio._closedConnIds.size, 64);
  assert.equal(audio._closedConnIds.has("c0"), false, "oldest evicted");
  assert.equal(audio._closedConnIds.has("c69"), true, "newest retained");
});

test("_connIdForUser finds an in-flight (not yet built) connection, not just a completed one", () => {
  const audio = new WaAudio(fakeClient());
  audio._peerUsers.set("building-conn", "peer-1");
  assert.equal(audio._connIdForUser("peer-1"), "building-conn");
  assert.equal(audio._connIdForUser("nobody"), null);
});
