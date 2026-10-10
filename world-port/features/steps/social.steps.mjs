import assert from "node:assert/strict";
import { When, Then } from "@cucumber/cucumber";

const role = (r) => r.toUpperCase();
const nameOf = (r) => `wa-probe-${r.toLowerCase()}`;
const FAKE_HOLD_MS = 50; // the fake has no clock-driven disconnects; a token wait keeps the scenario short

// scenario: social:A chat message in a shared meeting reaches the other avatar
When("avatar {word} says {string} in the meeting", async function (r, text) {
  const space = (this.events.get(role(r)) ?? []).filter((e) => e.event === "meetingJoined").at(-1)?.payload.spaceName;
  assert.ok(space, `${r} is not in a meeting`);
  (await this.avatar(role(r))).chat(space, text);
});

// scenario: social:A chat message in a shared meeting reaches the other avatar
Then("avatar {word} receives the chat message {string} from avatar {word}", async function (viewer, text, sender) {
  const m = await this.observe(role(viewer), "chatMessage", (p) => p.name === nameOf(sender) && p.text === text);
  assert.equal(m.text, text);
  assert.equal(m.name, nameOf(sender));
});

// scenario: social:Bubbles can be set and cleared without losing the connection
When("avatar {word} sets and clears a speech bubble and a thought bubble", async function (r) {
  const a = await this.avatar(role(r));
  a.speechBubble("probe says hi");
  a.clearBubble();
  a.thoughtBubble("probe thinks hi");
  a.clearBubble();
});

When("{int} seconds pass", async function (s) {
  const ms = this.kind === "live" ? s * 1000 : FAKE_HOLD_MS;
  await new Promise((res) => setTimeout(res, ms));
});

// scenario: social:Bubbles can be set and cleared without losing the connection
Then("avatar {word} is still connected", async function (r) {
  const log = this.events.get(role(r));
  assert.ok(log.some((e) => e.event === "joined"), "never joined");
  assert.ok(!log.some((e) => e.event === "rejected"), "was rejected");
  assert.equal((await this.avatar(role(r))).closed, false, "closed");
  assert.equal((await this.avatar(role(r))).self().name, nameOf(r));
});

// scenario: social:An emote reaches the other avatar
When("avatar {word} emotes {string}", async function (r, emoji) {
  (await this.avatar(role(r))).emote(emoji);
});

// scenario: social:An emote reaches the other avatar
Then("avatar {word} sees avatar {word} emote {string}", async function (viewer, sender, emoji) {
  const e = await this.observe(role(viewer), "emote", (p) => p.name === nameOf(sender) && p.emote === emoji);
  assert.equal(e.emote, emoji);
});
