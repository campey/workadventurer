// Space chat (#48) — SpaceMessage send/receive. Works the same whether the
// Space is a proximity bubble or a meeting-room area; see docs/field-notes.md
// for why that's one mechanism, not two, and why it isn't Matrix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";

function client() {
  const c = new WorkAdventureClient({ adapter: { envelope: "seq-len-v1" }, name: "claude" });
  c.sent = [];
  c._send = (m) => c.sent.push(m);
  return c;
}

test("sendChatMessage sends a publicEvent SpaceMessage for a joined space", () => {
  const c = client();
  c.spaces.set("space-1", { spaceUserId: "su-1", propertiesToSync: [], micTimers: [] });
  c.sendChatMessage("space-1", "hello");
  assert.deepEqual(c.sent, [
    {
      publicEvent: {
        spaceName: "space-1",
        spaceEvent: { spaceMessage: { message: "hello", name: "claude" } },
      },
    },
  ]);
});

test("sendChatMessage throws when not a member of that space", () => {
  const c = client();
  assert.throws(() => c.sendChatMessage("space-1", "hi"), /not a member of space space-1/);
});

test("an inbound publicEvent spaceMessage emits chatMessage", () => {
  const c = client();
  let got;
  c.on("chatMessage", (e) => (got = e));
  c._handleSub({
    publicEvent: {
      spaceName: "space-1",
      senderUserId: "su-2",
      spaceEvent: { spaceMessage: { message: "hi there" } },
    },
  });
  assert.deepEqual(got, {
    spaceName: "space-1",
    senderUserId: "su-2",
    name: "",
    text: "hi there",
  });
});

test("chatMessage prefers the sender's SpaceUser name over an explicit SpaceMessage.name", () => {
  const c = client();
  c._handleSub({ initSpaceUsersMessage: { spaceName: "space-1", users: [{ spaceUserId: "su-2", name: "David" }] } });
  let got;
  c.on("chatMessage", (e) => (got = e));
  c._handleSub({
    publicEvent: {
      spaceName: "space-1",
      senderUserId: "su-2",
      spaceEvent: { spaceMessage: { message: "hi" } },
    },
  });
  assert.equal(got.name, "David");
});

test("a spaceEvent with no spaceMessage (e.g. spaceIsTyping) is swallowed without a chatMessage event", () => {
  const c = client();
  let fired = false;
  c.on("chatMessage", () => (fired = true));
  assert.doesNotThrow(() => {
    c._handleSub({
      publicEvent: { spaceName: "space-1", senderUserId: "su-2", spaceEvent: { spaceIsTyping: { isTyping: true } } },
    });
  });
  assert.equal(fired, false);
});
