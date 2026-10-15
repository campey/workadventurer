// Peers' mic state, surfaced as `peerMic` from the space-user messages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";

function client() {
  const c = new WorkAdventureClient({ adapter: { envelope: "seq-len-v1" } });
  c.sent = [];
  c._send = (m) => c.sent.push(m);
  c.spaces.set("sp", { spaceUserId: "me_1", propertiesToSync: [], micTimers: [] });
  return c;
}
const collect = (c) => { const got = []; c.on("peerMic", (e) => got.push(e)); return got; };

test("updateSpaceUserMessage with microphoneState in the mask -> peerMic", () => {
  const c = client();
  const got = collect(c);
  c._handleSub({
    updateSpaceUserMessage: {
      spaceName: "sp",
      user: { spaceUserId: "peer_2", name: "Bea", microphoneState: true },
      updateMask: { paths: ["microphoneState"] },
    },
  });
  assert.deepEqual(got, [{ spaceName: "sp", spaceUserId: "peer_2", name: "Bea", on: true }]);
});

test("updateSpaceUserMessage with microphoneState in the mask and false -> peerMic off", () => {
  const c = client();
  const got = collect(c);
  c._handleSub({
    updateSpaceUserMessage: {
      spaceName: "sp",
      user: { spaceUserId: "peer_2", name: "Bea" },
      updateMask: { paths: ["microphoneState"] },
    },
  });
  assert.equal(got[0].on, false);
});

test("updateSpaceUserMessage without microphoneState in the mask -> no peerMic", () => {
  const c = client();
  const got = collect(c);
  c._handleSub({
    updateSpaceUserMessage: {
      spaceName: "sp",
      user: { spaceUserId: "peer_2", name: "Bea", microphoneState: true },
      updateMask: { paths: ["name"] },
    },
  });
  assert.deepEqual(got, []);
});

test("peerMic is not emitted for our own spaceUserId", () => {
  const c = client();
  const got = collect(c);
  c._handleSub({
    updateSpaceUserMessage: {
      spaceName: "sp",
      user: { spaceUserId: "me_1", microphoneState: true },
      updateMask: { paths: ["microphoneState"] },
    },
  });
  c._handleSub({
    initSpaceUsersMessage: { spaceName: "sp", users: [{ spaceUserId: "me_1", microphoneState: true }] },
  });
  assert.deepEqual(got, []);
});

test("initSpaceUsersMessage and addSpaceUserMessage -> peerMic per peer", () => {
  const c = client();
  const got = collect(c);
  c._handleSub({
    initSpaceUsersMessage: {
      spaceName: "sp",
      users: [{ spaceUserId: "p_3", name: "Cy", microphoneState: true }, { spaceUserId: "me_1" }],
    },
  });
  c._handleSub({
    addSpaceUserMessage: { spaceName: "sp", user: { spaceUserId: "p_4", name: "Di", microphoneState: false } },
  });
  assert.deepEqual(got, [
    { spaceName: "sp", spaceUserId: "p_3", name: "Cy", on: true },
    { spaceName: "sp", spaceUserId: "p_4", name: "Di", on: false },
  ]);
});
