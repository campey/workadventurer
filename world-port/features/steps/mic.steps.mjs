import { When, Then } from "@cucumber/cucumber";

const role = (r) => r.toUpperCase();
const nameOf = (r) => `wa-probe-${r.toLowerCase()}`;

// Log length of every avatar's event log right now. The "turns the microphone on/off" When
// records one, so the matching Then only accepts a peerMic told after the action, never a
// stale one from earlier in the scenario.
const markLogs = (world, key) => {
  world.micMarks ??= {};
  world.micMarks[key] = new Map([...world.events].map(([r, log]) => [r, log.length]));
};
const since = (world, key, viewer) => world.micMarks?.[key]?.get(role(viewer)) ?? 0;

// scenario: mic:A peer's microphone state is seen by the other avatar in the meeting
When("avatar {word} turns the microphone on", async function (r) {
  const a = await this.avatar(role(r));
  markLogs(this, `${role(r)}:on`);
  a.setMic(true);
});

// scenario: mic:A peer's microphone state is seen by the other avatar in the meeting
When("avatar {word} turns the microphone off", async function (r) {
  const a = await this.avatar(role(r));
  markLogs(this, `${role(r)}:off`);
  a.setMic(false);
});

// scenario: mic:A peer's microphone state is seen by the other avatar in the meeting
Then("avatar {word} sees avatar {word}'s microphone on", async function (viewer, sender) {
  await this.observe(role(viewer), "peerMic", (p) => p.name === nameOf(sender) && p.on === true,
    { since: since(this, `${role(sender)}:on`, viewer) });
});

// scenario: mic:A peer's microphone state is seen by the other avatar in the meeting
Then("avatar {word} sees avatar {word}'s microphone off", async function (viewer, sender) {
  await this.observe(role(viewer), "peerMic", (p) => p.name === nameOf(sender) && p.on === false,
    { since: since(this, `${role(sender)}:off`, viewer) });
});
