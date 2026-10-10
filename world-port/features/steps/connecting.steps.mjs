import assert from "node:assert/strict";
import { Given, When, Then } from "@cucumber/cucumber";
import { isVersionRejection } from "../../../src/server-rejected.mjs";
import { FakeServer } from "../../fake/fake-server.mjs";
import { waitFor } from "../../port.mjs";

const role = (r) => r.toUpperCase();

Given("the world {string}", function (id) {
  this.worldId = id;
});

// scenario: connecting:A version turned away after joining
Given("the server turns stale versions away after join", function () {
  this.server = new FakeServer({ rejectAfterJoin: true });
});

When("avatar {word} connects", async function (r) {
  const a = await this.avatar(role(r));
  const joined = waitFor(a, "joined");
  await a.connect();
  await joined;
});

When("avatar {word} connects with the stale version {string}", async function (r, versionHash) {
  const a = await this.avatar(role(r), { versionHash });
  // Rejection may reject connect() or arrive later as a `rejected` event.
  const rejected = waitFor(a, "rejected");
  rejected.catch(() => {}); // avoid unhandled rejection if connect() throws first
  this.outcome = await a.connect().then(() => rejected, (e) => e).catch((e) => e);
  rejected.cancel(); // no-op if settled; otherwise drop the listener and timer
});

Then("avatar {word} has joined the world", async function (r) {
  const me = (await this.avatar(role(r))).self();
  assert.ok(Number.isInteger(me.userId), "no userId: not joined");
});

Then("avatar {word} is told a new version is available", function (_r) {
  assert.ok(isVersionRejection(this.outcome), `expected a version rejection, got ${this.outcome}`);
});
