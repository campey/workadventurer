import { After } from "@cucumber/cucumber";

// Close every avatar the scenario created (close() is idempotent).
After(function () {
  for (const port of this.avatars.values()) port.close();
  this.avatars.clear();
});
