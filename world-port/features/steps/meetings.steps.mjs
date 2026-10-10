import assert from "node:assert/strict";
import { Given, When, Then } from "@cucumber/cucumber";

const role = (r) => r.toUpperCase();
const AWAY_PX = 400;
const NEXT_TO_PX = 32; // well inside the 64 px proximity radius

// scenario: presence:Walking next to another avatar puts both in the same meeting
Given("avatar {word} is {int} px away from avatar {word}", async function (mover, px, other) {
  const a = await this.avatar(role(other));
  assert.equal(px, AWAY_PX);
  const { x, y } = a.self();
  await (await this.avatar(role(mover))).moveTo(x + px, y);
});

When("avatar {word} walks next to avatar {word}", async function (walker, target) {
  this.mark = {};
  for (const r of ["A", "B"]) this.mark[r] = this.events.get(r)?.length ?? 0; // only meetings from now on count
  const t = (await this.avatar(role(target))).self();
  await (await this.avatar(role(walker))).moveTo(t.x - NEXT_TO_PX, t.y);
});

// scenario: presence:Walking next to another avatar puts both in the same meeting
Then("avatars {word} and {word} are in the same meeting", async function (r1, r2) {
  const joins = [];
  for (const r of [role(r1), role(r2)]) {
    joins.push(await this.observe(r, "meetingJoined", () => true, { since: this.mark?.[r] ?? 0 }));
  }
  assert.ok(joins[0].spaceName, "meetingJoined carried no spaceName");
  assert.equal(joins[0].spaceName, joins[1].spaceName);
});

// scenario: meetings:Walking into a meeting area joins its meeting
When("avatar {word} walks into the meeting area {string}", async function (r, areaName) {
  const area = (this.facts?.meetingAreas ?? []).find((a) => a.name === areaName);
  assert.ok(area, `meeting area "${areaName}" is not in the facts file`);
  await (await this.avatar(role(r))).moveTo(area.x + area.w / 2, area.y + area.h / 2);
});

// scenario: meetings:Walking into a meeting area joins its meeting
Then("avatar {word} joins the meeting for {string}", async function (r, areaName) {
  const area = (this.facts?.meetingAreas ?? []).find((a) => a.name === areaName);
  assert.ok(area, `meeting area "${areaName}" is not in the facts file`);
  const space = area.space ?? area.name;
  await this.observe(role(r), "meetingJoined", (p) => p.spaceName === space);
});
