import { When, Then } from "@cucumber/cucumber";

const role = (r) => r.toUpperCase();
const nameOf = (r) => `wa-probe-${r.toLowerCase()}`;

// scenario: mic:A peer's microphone state is seen by the other avatar in the meeting
When("avatar {word} turns the microphone on", async function (r) {
  (await this.avatar(role(r))).setMic(true);
});

// scenario: mic:A peer's microphone state is seen by the other avatar in the meeting
When("avatar {word} turns the microphone off", async function (r) {
  (await this.avatar(role(r))).setMic(false);
});

// scenario: mic:A peer's microphone state is seen by the other avatar in the meeting
Then("avatar {word} sees avatar {word}'s microphone on", async function (viewer, sender) {
  this.micMark = this.events.get(role(viewer)).length;
  await this.observe(role(viewer), "peerMic", (p) => p.name === nameOf(sender) && p.on === true);
});

// scenario: mic:A peer's microphone state is seen by the other avatar in the meeting
Then("avatar {word} sees avatar {word}'s microphone off", async function (viewer, sender) {
  await this.observe(role(viewer), "peerMic", (p) => p.name === nameOf(sender) && p.on === false, { since: this.micMark ?? 0 });
});
