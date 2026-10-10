import { After, Before } from "@cucumber/cucumber";

// Close every avatar the scenario created (close() is idempotent).
After(function () {
  for (const port of this.avatars.values()) port.close();
  this.avatars.clear();
});

// @fake scenarios rely on fake-only server behaviour; skip them against the live world.
Before({ tags: "@fake" }, function () {
  if (this.kind === "live") return "skipped";
});
