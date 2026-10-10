import assert from "node:assert/strict";
import { Given, When, Then } from "@cucumber/cucumber";

const role = (r) => r.toUpperCase();
const AWAY_PX = 400;
const NEXT_TO_PX = 32; // well inside the 64 px proximity radius

// Destinations are open floor outside meeting areas, never a raw offset into a wall or an area.
export const spot = (avatar, x, y) => { const p = avatar.openSpotNear(x, y); return [p.x, p.y]; };

// scenario: presence:Walking next to another avatar puts both in the same meeting
Given("avatar {word} is {int} px away from avatar {word}", async function (mover, px, other) {
  const a = await this.avatar(role(other));
  assert.equal(px, AWAY_PX);
  const { x, y } = a.self();
  const walker = await this.avatar(role(mover));
  await walker.moveTo(...spot(walker, x + px, y));
});

When("avatar {word} walks next to avatar {word}", async function (walker, target) {
  this.mark = {};
  for (const r of ["A", "B"]) this.mark[r] = this.events.get(r)?.length ?? 0; // only meetings from now on count
  const t = (await this.avatar(role(target))).self();
  const w = await this.avatar(role(walker));
  await w.moveTo(...spot(w, t.x - NEXT_TO_PX, t.y));
});

// scenario: presence:Walking next to another avatar puts both in the same meeting
Then("avatars {word} and {word} are in the same meeting", async function (r1, r2) {
  const joins = [];
  for (const r of [role(r1), role(r2)]) {
    joins.push(await this.observe(r, "meetingJoined", () => true, { since: this.mark?.[r] ?? 0 }));
  }
  assert.ok(joins[0].spaceName, "meetingJoined carried no spaceName");
  assert.equal(joins[0].spaceName, joins[1].spaceName);
  this.proximitySpace = joins[0].spaceName;
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

// scenario: meetings:A proximity pair walking into a meeting area leaves its bubble for the area meeting
When("avatars {word} and {word} walk into the meeting area {string}", async function (r1, r2, areaName) {
  const area = (this.facts?.meetingAreas ?? []).find((a) => a.name === areaName);
  assert.ok(area, `meeting area "${areaName}" is not in the facts file`);
  this.areaMark = {};
  for (const r of [role(r1), role(r2)]) this.areaMark[r] = this.events.get(r)?.length ?? 0; // only what follows counts
  const centre = [area.x + area.w / 2, area.y + area.h / 2];
  // Together, so the pair stays a pair on the way in.
  await Promise.all([r1, r2].map(async (r) => (await this.avatar(role(r))).moveTo(...centre)));
});

// scenario: meetings:A proximity pair walking into a meeting area leaves its bubble for the area meeting
Then("avatars {word} and {word} join the meeting for {string}", async function (r1, r2, areaName) {
  const area = (this.facts?.meetingAreas ?? []).find((a) => a.name === areaName);
  const space = area.space ?? area.name;
  for (const r of [role(r1), role(r2)]) {
    await this.observe(r, "meetingJoined", (p) => p.spaceName === space, { since: this.areaMark?.[r] ?? 0 });
  }
});

// Once both are in the area meeting, the last thing each was told about the proximity meeting is that it
// ended. (The pair may separate and re-form on the way in; what matters is that the bubble is gone at the
// end, with both in the area meeting, not that it ended at one particular moment.)
// scenario: meetings:A proximity pair walking into a meeting area leaves its bubble for the area meeting
Then("avatars {word} and {word} have left the proximity meeting for the meeting for {string}", async function (r1, r2, areaName) {
  assert.ok(this.proximitySpace, "no proximity meeting was seen first");
  const area = (this.facts?.meetingAreas ?? []).find((a) => a.name === areaName);
  const space = area.space ?? area.name;
  for (const r of [role(r1), role(r2)]) {
    const log = this.events.get(r);
    const proximityEvents = () =>
      log.slice(this.areaMark?.[r] ?? 0).filter((e) => (e.event === "meetingJoined" || e.event === "meetingLeft") && e.payload?.spaceName === this.proximitySpace);
    const inArea = () => log.some((e, i) => i >= (this.areaMark?.[r] ?? 0) && e.event === "meetingJoined" && e.payload?.spaceName === space);
    const done = () => inArea() && proximityEvents().at(-1)?.event === "meetingLeft";
    const deadline = Date.now() + 15000;
    while (!done() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
    assert.ok(done(), `${r} is still in the proximity meeting ${this.proximitySpace} (events: ${JSON.stringify(proximityEvents().map((e) => e.event))})`);
  }
});
