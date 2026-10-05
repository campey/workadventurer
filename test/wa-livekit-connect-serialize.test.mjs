// Found live with a multi-agent bench: WA sent two livekitInvitationMessages
// back to back, so two room.connect() calls ran concurrently under one
// identity. The server kicks the older connection on a duplicate identity,
// silently orphaning its STT streams — and the survivor then skipped those
// tracks as "already listening". Connects must never overlap, and a burst of
// invitations should collapse to the latest one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WaAudio } from "../src/wa-audio.mjs";

function fakeClient() {
  const c = new EventEmitter();
  c.micOn = true;
  c.spaces = new Map([["s1", { spaceUserId: "u1" }]]);
  c._send = () => {};
  c.setSpaceMicState = () => {};
  c.query = async () => ({ iceServersAnswer: { iceServers: [] } });
  c.adapter = { micState: { speakingMaskPaths: ["showVoiceIndicator", "microphoneState"] } };
  return c;
}

function instrument(audio, connectMs = 30) {
  const state = { active: 0, maxActive: 0, connects: [], disconnects: 0 };
  audio._disconnectLiveKit = async () => { state.disconnects++; };
  audio._doConnectLiveKit = async (token) => {
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    state.connects.push(token);
    await new Promise((r) => setTimeout(r, connectMs));
    state.active--;
  };
  return state;
}

test("two back-to-back invitations never run connects concurrently", async () => {
  const audio = new WaAudio(fakeClient());
  const s = instrument(audio);
  await Promise.all([
    audio._connectLiveKit({ token: "A", serverUrl: "wss://x" }),
    audio._connectLiveKit({ token: "B", serverUrl: "wss://x" }),
  ]);
  assert.equal(s.maxActive, 1, "overlapping room.connect() calls share an identity — the server would kick one");
});

test("a burst of invitations collapses to the latest one", async () => {
  const audio = new WaAudio(fakeClient());
  const s = instrument(audio);
  await Promise.all([
    audio._connectLiveKit({ token: "A", serverUrl: "wss://x" }),
    audio._connectLiveKit({ token: "B", serverUrl: "wss://x" }),
    audio._connectLiveKit({ token: "C", serverUrl: "wss://x" }),
  ]);
  assert.equal(s.connects.at(-1), "C", "the newest invitation must be the one that ends up connected");
  assert.ok(s.connects.length <= 2, `intermediate invitations are dropped, got ${s.connects.join(",")}`);
});

test("a failed connect doesn't wedge the queue for the next invitation", async () => {
  const audio = new WaAudio(fakeClient());
  const s = instrument(audio, 5);
  const real = audio._doConnectLiveKit;
  audio._doConnectLiveKit = async (token, url) => {
    if (token === "bad") throw new Error("boom");
    return real(token, url);
  };
  await assert.rejects(audio._connectLiveKit({ token: "bad", serverUrl: "wss://x" }), /boom/);
  await audio._connectLiveKit({ token: "good", serverUrl: "wss://x" });
  assert.deepEqual(s.connects, ["good"]);
});

test("_livekitConnecting covers a queued connect, so waitForLiveKit waits for it", async () => {
  const audio = new WaAudio(fakeClient());
  instrument(audio, 40);
  const p = audio._connectLiveKit({ token: "A", serverUrl: "wss://x" });
  assert.ok(audio._livekitConnecting, "set synchronously, before the connect actually starts");
  await audio.waitForLiveKit(1000);
  await p;
  assert.equal(audio._livekitConnecting, null, "cleared once settled");
});
