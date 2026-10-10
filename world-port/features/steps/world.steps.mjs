import assert from "node:assert/strict";
import { Given, Then } from "@cucumber/cucumber";
import { waitFor } from "../../port.mjs";

const role = (r) => r.toUpperCase();
const TILE = 32; // the client nudges spawn to a free tile centre; same slack as probes/spawn.mjs

Given("avatar {word} is in the world", async function (r) {
  const a = await this.avatar(role(r));
  await a.connect();
});

// scenario: spawn:I appear in the world's start area
Then("avatar {word} sees avatar {word} inside the start area", async function (viewer, subject) {
  const b = await this.avatar(role(viewer));
  const a = await this.avatar(role(subject));
  const area = b.startArea();
  assert.ok(area, "no start area known for this world");
  const seen = a.self();
  const aName = seen.name;
  // Already announced (fake joins synchronously) or still to come (live).
  const known = b.players().find((p) => p.name === aName);
  const p = known ?? (await waitFor(b, "playerJoined", (q) => q.name === aName, 20000));
  const inside =
    p.x >= area.x - TILE && p.x <= area.x + area.w + TILE &&
    p.y >= area.y - TILE && p.y <= area.y + area.h + TILE;
  assert.ok(inside, `${aName} seen at (${p.x},${p.y}), outside start area ${JSON.stringify(area)} +/-${TILE}px`);
});

// scenario: walls:The world says what is solid
Then("the world says {string} is {word}", async function (landmark, state) {
  assert.ok(state === "solid" || state === "open", `state must be solid or open, got ${state}`);
  const l = (this.facts?.landmarks ?? []).find((m) => m.name === landmark);
  assert.ok(l, `landmark "${landmark}" is not in the facts file`);
  const a = await this.avatar("A");
  assert.equal(a.isSolid(l.x, l.y), state === "solid", `${landmark} at (${l.x},${l.y})`);
});
