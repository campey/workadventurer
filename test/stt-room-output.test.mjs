import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSttRoomOutput } from "../src/stt-room-output.mjs";

function fake(names = {}) {
  const c = { calls: [], spaces: new Map([["s1", {}], ["s2", {}]]) };
  c.spaceUserName = (id) => names[id] ?? null;
  c.thoughtBubble = (t) => c.calls.push(["bubble", t]);
  c.clearBubble = () => c.calls.push(["clear"]);
  c.sendChatMessage = (s, t) => c.calls.push(["chat", s, t]);
  return c;
}

test("partial -> thought bubble only, labelled with the speaker", () => {
  const c = fake({ u1: "David" });
  makeSttRoomOutput(c)({ remoteUserId: "u1", text: "hello wor", final: false });
  assert.deepEqual(c.calls, [["bubble", "David: hello wor"]]);
});

test("final -> clear bubble, then one chat line per joined space", () => {
  const c = fake({ u1: "David" });
  makeSttRoomOutput(c)({ remoteUserId: "u1", text: "hello world", final: true });
  assert.deepEqual(c.calls, [["clear"], ["chat", "s1", "David: hello world"], ["chat", "s2", "David: hello world"]]);
});

test("unknown speaker falls back to the id tail", () => {
  const c = fake();
  makeSttRoomOutput(c)({ remoteUserId: "https://x/room_7", text: "hi", final: true });
  assert.equal(c.calls[1][2], "room_7: hi");
});

test("empty text does nothing", () => {
  const c = fake();
  makeSttRoomOutput(c)({ remoteUserId: "u1", text: "", final: true });
  makeSttRoomOutput(c)({ remoteUserId: "u1", text: "", final: false });
  assert.deepEqual(c.calls, []);
});

test("final with no joined space clears the bubble and sends nothing", () => {
  const c = fake();
  c.spaces.clear();
  makeSttRoomOutput(c)({ remoteUserId: "u1", text: "hi", final: true });
  assert.deepEqual(c.calls, [["clear"]]);
});
