import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LiveWorld } from "../world-port/live/live-world.mjs";
import { EVENTS } from "../world-port/port.mjs";

class StubWS extends EventEmitter { close() {} }
const stubFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
const mk = () => new LiveWorld({ roomUrl: "https://x.test/@/o/w/r", name: "wa-probe-t", fetch: stubFetch, WebSocketImpl: StubWS });

test("voiceSignal is a port event", () => assert.ok(EVENTS.includes("voiceSignal")));

test("enableVoice maps webRtcStart and livekit invitation to voiceSignal; other kinds are ignored", async () => {
  const w = mk();
  w.client.close = () => {};
  w.client.spaceUserNames.set("sp_7", "wa-probe-b");
  let hung = 0;
  const audio = { hangup() { hung++; } };
  let made = 0;
  await w.enableVoice({ makeAudio: (c) => { made++; assert.equal(c, w.client); return audio; } });
  await w.enableVoice({ makeAudio: () => { made++; return audio; } }); // idempotent
  assert.equal(made, 1);
  const got = [];
  w.on("voiceSignal", (s) => got.push(s));
  w.client.emit("spaceEvent", { kind: "webRtcStartMessage", senderUserId: "sp_7", payload: {} });
  w.client.emit("spaceEvent", { kind: "webRtcStartMessage", senderUserId: "sp_9", payload: {} });
  w.client.emit("spaceEvent", { kind: "livekitInvitationMessage", senderUserId: "sp_7", payload: {} });
  w.client.emit("spaceEvent", { kind: "webRtcSignal", senderUserId: "sp_7", payload: {} });
  assert.deepEqual(got, [
    { kind: "webrtc", with: "wa-probe-b" },
    { kind: "webrtc", with: null },
    { kind: "livekit", with: null },
  ]);
  w.close();
  assert.equal(hung, 1);
  w.client.emit("spaceEvent", { kind: "webRtcStartMessage", senderUserId: "sp_7", payload: {} });
  assert.equal(got.length, 3, "no emission after close");
});

test("without enableVoice nothing is emitted and no audio exists", () => {
  const w = mk();
  const got = [];
  w.on("voiceSignal", (s) => got.push(s));
  w.client.emit("spaceEvent", { kind: "webRtcStartMessage", senderUserId: "x", payload: {} });
  assert.equal(got.length, 0);
  assert.equal(w.audio, undefined);
});
