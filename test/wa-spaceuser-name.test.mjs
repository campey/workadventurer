// SpaceUser carries both spaceUserId and name directly — the client should
// learn that mapping from initSpaceUsersMessage so peers (e.g. STT speakers,
// issue #23) can be labelled without cross-referencing the room's userId.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";

function client() {
  const c = new WorkAdventureClient({ adapter: { envelope: "seq-len-v1" } });
  c._send = () => {};
  return c;
}

test("initSpaceUsersMessage populates spaceUserName()", () => {
  const c = client();
  assert.equal(c.spaceUserName("space-user-1"), null);

  c._handleSub({
    initSpaceUsersMessage: {
      spaceName: "s1",
      users: [
        { spaceUserId: "space-user-1", name: "David" },
        { spaceUserId: "space-user-2", name: "Ada" },
        { spaceUserId: "space-user-3" }, // no name — skipped, not "undefined"
      ],
    },
  });

  assert.equal(c.spaceUserName("space-user-1"), "David");
  assert.equal(c.spaceUserName("space-user-2"), "Ada");
  assert.equal(c.spaceUserName("space-user-3"), null);
  assert.equal(c.spaceUserName("never-seen"), null);
});

test("a later initSpaceUsersMessage updates an existing name", () => {
  const c = client();
  c._handleSub({ initSpaceUsersMessage: { spaceName: "s1", users: [{ spaceUserId: "u1", name: "Old" }] } });
  assert.equal(c.spaceUserName("u1"), "Old");
  c._handleSub({ initSpaceUsersMessage: { spaceName: "s1", users: [{ spaceUserId: "u1", name: "New" }] } });
  assert.equal(c.spaceUserName("u1"), "New");
});
