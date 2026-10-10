import assert from "node:assert/strict";
import { Given, When, Then } from "@cucumber/cucumber";
import { FakeWorld } from "../../fake/fake-world.mjs";

const role = (r) => r.toUpperCase();
const nameOf = (r) => `wa-probe-${r.toLowerCase()}`;
const STEP_PX = 100;

// Presence is matched by our avatar's name, so strangers in a live world are ignored.

// scenario: presence:A player's arrival, movement and departure are seen
Then("avatar {word} sees avatar {word} arrive", async function (viewer, subject) {
  const name = nameOf(subject);
  const known = (await this.avatar(role(viewer))).players().find((p) => p.name === name);
  if (known) return;
  await this.observe(role(viewer), "playerJoined", (p) => p.name === name, { timeoutMs: 20000 });
});

When("avatar {word} walks {int} px east", async function (r, px) {
  const b = await this.avatar(role(r));
  const { x, y } = b.self();
  this.walkedTo = { name: nameOf(r), x: x + px, y };
  await b.moveTo(x + px, y);
});

// scenario: presence:A player's arrival, movement and departure are seen
Then("avatar {word} sees avatar {word} move", async function (viewer, subject) {
  assert.equal(this.walkedTo?.name, nameOf(subject), "no preceding walk by that avatar");
  const { name, x, y } = this.walkedTo;
  const there = (p) => p.name === name && p.x === x && p.y === y;
  if ((await this.avatar(role(viewer))).players().some(there)) return;
  await this.observe(role(viewer), "playerMoved", there);
});

When("avatar {word} leaves", async function (r) {
  (await this.avatar(role(r))).close();
});

// scenario: presence:A player's arrival, movement and departure are seen
Then("avatar {word} sees avatar {word} leave", async function (viewer, subject) {
  const name = nameOf(subject);
  const v = await this.avatar(role(viewer));
  if (!v.players().some((p) => p.name === name)) return;
  await this.observe(role(viewer), "playerLeft", (p) => p.name === name);
});

// scenario: presence:Strangers are not mistaken for our avatars
Then("avatar {word} does not see avatar {word} arrive", async function (viewer, subject) {
  const name = nameOf(subject);
  assert.ok(!(await this.avatar(role(viewer))).players().some((p) => p.name === name), `${name} is present`);
});

// scenario: presence:Strangers are not mistaken for our avatars
Given("a stranger named {string} arrives, moves and leaves", async function (name) {
  const stranger = new FakeWorld({ server: this.server, name, facts: this.facts });
  await stranger.connect();
  await stranger.moveTo(500, 500);
  stranger.close();
});
