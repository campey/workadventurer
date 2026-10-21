import assert from "node:assert/strict";
import { When, Then } from "@cucumber/cucumber";

const role = (r) => r.toUpperCase();
const nameOf = (r) => `wa-probe-${r.toLowerCase()}`;

// scenario: invites:An invitation is received, accepted and brings both avatars together
When("avatar {word} invites avatar {word}", async function (sender, target) {
  await (await this.avatar(role(target))).players(); // ensure the target exists
  this.mark = {};
  for (const r of ["A", "B"]) this.mark[r] = this.events.get(r)?.length ?? 0;
  (await this.avatar(role(sender))).invite(nameOf(target));
});

// scenario: invites:An invitation is received, accepted and brings both avatars together
Then("avatar {word} is told avatar {word} invited them", async function (viewer, sender) {
  await this.observe(role(viewer), "inviteReceived", (p) => p.name === nameOf(sender));
});

// scenario: invites:An invitation is received, accepted and brings both avatars together
When("avatar {word} accepts the invitation from avatar {word}", async function (r, sender) {
  await (await this.avatar(role(r))).acceptInvite(nameOf(sender));
});

// scenario: invites:An invitation is received, accepted and brings both avatars together
Then("avatar {word} is told avatar {word} accepted", async function (viewer, responder) {
  const a = await this.observe(role(viewer), "inviteAnswered", (p) => p.name === nameOf(responder));
  assert.equal(a.accepted, true);
});

// scenario: invites:Inviting someone who is not in the world is an error
Then("avatar {word} cannot invite {string}", async function (r, name) {
  const a = await this.avatar(role(r));
  assert.throws(() => a.invite(name), /unknown player/);
});
