// #10: a fast leave→rejoin (routine with the area-meeting dwell/linger
// debounce) must not let a stale mic re-announce timer from the space we just
// left fire against a later membership of the same space.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkAdventureClient } from "../src/wa-client.mjs";

function client(micReannounceMs) {
  const c = new WorkAdventureClient({
    adapter: {
      envelope: "seq-len-v1",
      spaceJoin: {
        filterType: 0,
        defaultPropsToSync: [],
        watchViaAddSpaceFilter: false,
        micReannounceMs,
      },
    },
  });
  c._send = () => {};
  c.micOn = true;
  c.query = async () => ({ joinSpaceAnswer: { spaceUserId: "u1" } });
  c.calls = [];
  c.setSpaceMicState = (spaceName, on) => c.calls.push({ spaceName, on });
  return c;
}

test("_leaveSpace clears pending mic re-announce timers", async () => {
  const c = client([0, 50, 100]);

  await c._joinSpace("s1");
  c._leaveSpace("s1"); // leave immediately — the 50ms/100ms timers are still pending

  await sleep(200); // past every scheduled delay
  assert.equal(c.calls.length, 1, "only the ms:0 synchronous announce, no orphaned timers");
  assert.equal(c.calls[0].on, true);
});

test("a stale timer from a left space does not fire against a later rejoin", async () => {
  const c = client([0, 80]);

  await c._joinSpace("s1");
  c._leaveSpace("s1");
  c.calls.length = 0; // ignore the join-time announce; only care about post-leave activity

  await c._joinSpace("s1"); // rejoin — schedules its own fresh timers
  await sleep(150); // past both the rejoin's 80ms timer and where the original's would have fired

  // Exactly the rejoin's own two announces (ms:0 + ms:80) — a leftover,
  // uncleared timer from the first join would add a third.
  assert.equal(c.calls.filter((x) => x.on === true).length, 2, "ms:0 + ms:80 from the rejoin only");
});
