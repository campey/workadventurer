import assert from "node:assert/strict";
import { Given, When, Then } from "@cucumber/cucumber";

const role = (r) => r.toUpperCase();
const AWAY_PX = 400;
const PROXIMITY_RANGE_PX = 64; // the proximity radius
const NEXT_TO_PX = 32; // well inside the 64 px proximity radius

// Destinations are open floor outside meeting areas, never a raw offset into a wall or an area.
// Inside a meeting area on open floor: an area's centre may be solid (the Fire Pit's fire), and an avatar
// cannot walk there.
const spotInside = (avatar, area) => { const p = avatar.openSpotInside(area.x, area.y, area.w, area.h); return [p.x, p.y]; };
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
  const a = await this.avatar(role(r));
  await a.moveTo(...spotInside(a, area));
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
  // Together, so the pair stays a pair on the way in.
  await Promise.all([r1, r2].map(async (r) => {
    const a = await this.avatar(role(r));
    await a.moveTo(...spotInside(a, area));
  }));
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
// ended, no other meeting is still open, and the two are within proximity range of each other: so the bubble
// did not end merely because they drifted apart, and did not re-form under another name. (The pair may
// separate and re-form on the way in; what matters is the end state with both in the area meeting.)
// scenario: meetings:A proximity pair walking into a meeting area leaves its bubble for the area meeting
Then("avatars {word} and {word} have left the proximity meeting for the meeting for {string}", { timeout: 25000 }, async function (r1, r2, areaName) {
  assert.ok(this.proximitySpace, "no proximity meeting was seen first");
  const area = (this.facts?.meetingAreas ?? []).find((a) => a.name === areaName);
  const space = area.space ?? area.name;
  const roles = [role(r1), role(r2)];
  const problems = (r) => {
    const log = this.events.get(r).slice(this.areaMark?.[r] ?? 0);
    const spaceEvents = log.filter((e) => e.event === "meetingJoined" || e.event === "meetingLeft");
    const p = [];
    if (!spaceEvents.some((e) => e.event === "meetingJoined" && e.payload?.spaceName === space)) p.push(`never joined ${space}`);
    const last = spaceEvents.filter((e) => e.payload?.spaceName === this.proximitySpace).at(-1);
    if (last?.event !== "meetingLeft") p.push(`still in proximity meeting ${this.proximitySpace}`);
    const open = new Map(); // spaceName -> open?
    for (const e of spaceEvents) open.set(e.payload?.spaceName, e.event === "meetingJoined");
    for (const [name, isOpen] of open) if (isOpen && name !== space) p.push(`other meeting still open: ${name}`);
    return p;
  };
  const apart = async () => {
    const [p, q] = await Promise.all(roles.map(async (r) => (await this.avatar(r)).self()));
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    return d <= PROXIMITY_RANGE_PX ? [] : [`${roles.join(" and ")} are ${Math.round(d)} px apart (range ${PROXIMITY_RANGE_PX}): the bubble could have ended by distance`];
  };
  const all = async () => [...roles.flatMap((r) => problems(r).map((m) => `${r}: ${m}`)), ...(await apart())];
  const deadline = Date.now() + (this.kind === "live" ? 15000 : 3000);
  let found = await all();
  while (found.length && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 100));
    found = await all();
  }
  assert.deepEqual(found, [], "the area meeting did not take over from the proximity bubble");
});
