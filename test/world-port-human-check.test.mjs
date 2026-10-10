// askHuman: a question in a speech bubble, answered by a person's emote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { askHuman } from "../world-port/probes/human-check.mjs";

function avatar() {
  const a = new EventEmitter();
  a.bubbles = [];
  a.speechBubble = (t) => a.bubbles.push(t);
  a.clearBubble = () => a.bubbles.push(null);
  return a;
}

test("👍 from a person answers good and clears the bubble", async () => {
  const a = avatar();
  const p = askHuman(a, "#1: wall ←");
  assert.match(a.bubbles[0], /^#1: wall ← — 👍 good \/ 😂 wrong$/);
  a.emit("emote", { name: "David", emote: "👍" });
  assert.equal(await p, "good");
  assert.equal(a.bubbles.at(-1), null);
});

test("😂 answers wrong; other emotes and our own probe avatars are ignored", async () => {
  const a = avatar();
  const p = askHuman(a, "#2");
  a.emit("emote", { name: "wa-probe-b", emote: "👍" });
  a.emit("emote", { name: "David", emote: "🎉" });
  a.emit("emote", { name: "David", emote: "😂" });
  assert.equal(await p, "wrong");
});

test("no answer within the timeout", async () => {
  const a = avatar();
  assert.equal(await askHuman(a, "#3", { timeoutMs: 20 }), "no answer");
  assert.equal(a.listenerCount("emote"), 0);
});
