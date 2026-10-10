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

// @needs-facts scenarios compare against a confirmed fact; with none on file there is nothing to assert.
// The world is named by the scenario's own `Given the world "<name>"` step (already expanded from the
// Examples row), which has not run yet when this hook fires, so read it from the pickle.
Before({ tags: "@needs-facts" }, function ({ pickle }) {
  const m = pickle.steps.map((s) => /^the world "(.+)"$/.exec(s.text)).find(Boolean);
  const world = m && WORLDS[m[1]];
  this.worldId = m?.[1] ?? null;
  if (!world || !this.facts.startArea) {
    this.log("skipped: no confirmed start area");
    return "skipped";
  }
});
