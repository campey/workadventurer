import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeServer } from "../world-port/fake/fake-server.mjs";
import { FakeWorld } from "../world-port/fake/fake-world.mjs";

// Probe voice-signalling, 2026-10-10: a proximity pair sees WEBRTC signalling, no LiveKit invitation.
const pair = async ({ voiceA = true, voiceB = true } = {}) => {
  const server = new FakeServer();
  const a = new FakeWorld({ server, name: "wa-probe-a" });
  const b = new FakeWorld({ server, name: "wa-probe-b" });
  if (voiceA) await a.enableVoice();
  if (voiceB) await b.enableVoice();
  const got = { a: [], b: [] };
  a.on("voiceSignal", (s) => got.a.push(s));
  b.on("voiceSignal", (s) => got.b.push(s));
  await a.connect();
  await b.connect();
  return { a, b, got };
};

test("a proximity pair with voice enabled sees WEBRTC signalling (with: null, as live for the walker), never LiveKit", async () => {
  const { a, b, got } = await pair();
  await b.moveTo(a.self().x + 32, a.self().y);
  assert.deepEqual(got.a, [{ kind: "webrtc", with: null }]);
  assert.deepEqual(got.b, [{ kind: "webrtc", with: null }]);
  a.close(); b.close();
});

test("voice is off by default: no voiceSignal without enableVoice()", async () => {
  const { a, b, got } = await pair({ voiceA: false, voiceB: false });
  await b.moveTo(a.self().x + 32, a.self().y);
  assert.deepEqual(got, { a: [], b: [] });
  a.close(); b.close();
});
