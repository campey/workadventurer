import { After, Before } from "@cucumber/cucumber";
import { WORLDS } from "../../worlds/index.mjs";

// Close every avatar the scenario created (close() is idempotent).
After(function () {
  for (const port of this.avatars.values()) port.close();
  this.avatars.clear();
});

// @fake scenarios rely on fake-only server behaviour; skip them against the live world.
Before({ tags: "@fake" }, function () {
  if (this.kind === "live") return "skipped";
});

// One tag per fact a scenario needs; with that fact missing there is nothing confirmed to assert, so skip.
// The world is named by the scenario's own `Given the world "<name>"` step (already expanded from the
// Examples row), which has not run yet when the hook fires, so read it from the pickle.
const pickleWorld = (pickle) => {
  const m = pickle.steps.map((s) => /^the world "(.+)"$/.exec(s.text)).find(Boolean);
  return m?.[1] ?? null;
};

Before({ tags: "@needs-start-area" }, function ({ pickle }) {
  this.worldId = pickleWorld(pickle);
  if (!WORLDS[this.worldId] || !this.facts.startArea) {
    this.log("skipped: no confirmed start area");
    return "skipped";
  }
});

Before({ tags: "@needs-meeting-area" }, function ({ pickle }) {
  this.worldId = pickleWorld(pickle);
  const m = pickle.steps.map((s) => /^avatars? \w+(?: and \w+)? walks? into the meeting area "(.+)"$/.exec(s.text)).find(Boolean);
  const listed = (this.facts.meetingAreas ?? []).some((a) => a.name === m?.[1]);
  if (!WORLDS[this.worldId] || !m || !listed) {
    this.log(`skipped: no confirmed meeting area "${m?.[1] ?? "?"}"`);
    return "skipped";
  }
});
