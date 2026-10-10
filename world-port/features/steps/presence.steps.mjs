import assert from "node:assert/strict";
import { Given, When, Then } from "@cucumber/cucumber";
import { FakeWorld } from "../../fake/fake-world.mjs";

const role = (r) => r.toUpperCase();
const nameOf = (r) => `wa-probe-${r.toLowerCase()}`;
const ARRIVED_PX = 24; // live avatars stop within 16 px of the spot they walk to; the fake lands exactly

// Presence is matched by our avatar's name, so strangers in a live world are ignored.

// Presence is asserted on the events in the viewer's log, never on players() state: a step must fail
// if the world stops announcing, and must match our avatar by name (a stranger's event never counts).
const toldAbout = (world, viewer, event, name, match = () => true) =>
  (world.events.get(role(viewer)) ?? []).some((e) => e.event === event && e.payload?.name === name && match(e.payload));

// scenario: presence:A player's arrival, movement and departure are seen
Then("avatar {word} sees avatar {word} arrive", async function (viewer, subject) {
  const name = nameOf(subject);
  await this.avatar(role(viewer));
  const p = await this.observe(role(viewer), "playerJoined", (q) => q.name === name, { timeoutMs: 20000 });
  assert.equal(p.name, name);
});

When("avatar {word} walks {int} px east", async function (r, px) {
  const b = await this.avatar(role(r));
  const { x, y } = b.self();
  const p = b.openSpotNear(x + px, y);
  this.walkedTo = { name: nameOf(r), x: p.x, y: p.y };
  await b.moveTo(p.x, p.y);
});

// scenario: presence:A player's arrival, movement and departure are seen
Then("avatar {word} sees avatar {word} move", async function (viewer, subject) {
  assert.equal(this.walkedTo?.name, nameOf(subject), "no preceding walk by that avatar");
  const { name, x, y } = this.walkedTo;
  await this.observe(role(viewer), "playerMoved", (p) => p.name === name && Math.hypot(p.x - x, p.y - y) <= ARRIVED_PX);
});

When("avatar {word} leaves", async function (r) {
  (await this.avatar(role(r))).close();
});

// scenario: presence:A player's arrival, movement and departure are seen
Then("avatar {word} sees avatar {word} leave", async function (viewer, subject) {
  const name = nameOf(subject);
  await this.observe(role(viewer), "playerLeft", (p) => p.name === name);
});

// scenario: presence:Strangers are not mistaken for our avatars
Then("avatar {word} has not been told avatar {word} arrived", async function (viewer, subject) {
  assert.ok(!toldAbout(this, viewer, "playerJoined", nameOf(subject)), `${nameOf(subject)} was announced`);
});

// scenario: presence:Strangers are not mistaken for our avatars
Then("avatar {word} has been told {string} arrived", async function (viewer, name) {
  await this.observe(role(viewer), "playerJoined", (p) => p.name === name, { timeoutMs: 20000 });
});

// scenario: presence:Strangers are not mistaken for our avatars
Then("avatar {word} does not see avatar {word} arrive", async function (viewer, subject) {
  const name = nameOf(subject);
  assert.ok(!(await this.avatar(role(viewer))).players().some((p) => p.name === name), `${name} is present`);
});

// scenario: presence:Strangers are not mistaken for our avatars
Given("a stranger named {string} arrives and moves", async function (name) {
  this.stranger = new FakeWorld({ server: this.server, name, facts: this.facts });
  await this.stranger.connect();
  await this.stranger.moveTo(500, 500);
});

// scenario: presence:Strangers are not mistaken for our avatars
Given("the stranger leaves", function () {
  this.stranger.close();
});
