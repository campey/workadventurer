// "Invite over" — WorkAdventure's MeetingInvitation flow. The client surfaces an
// inbound invite as `inviteReceived` and can accept it; the daemon then walks
// the avatar to the sender.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";

function client() {
  const c = new WorkAdventureClient({ adapter: { envelope: "seq-len-v1" } });
  c.sent = [];
  c._send = (m) => c.sent.push(m);
  return c;
}

test("meetingInvitationRequestReceivedMessage -> inviteReceived event", () => {
  const c = client();
  let got;
  c.on("inviteReceived", (e) => (got = e));
  c._handle({
    meetingInvitationRequestReceivedMessage: {
      senderUserUuid: "u-1",
      senderName: "David",
      senderUserId: 7,
      senderPlayUri: "https://play/x",
    },
  });
  assert.deepEqual(got, {
    uuid: "u-1",
    name: "David",
    userId: 7,
    playUri: "https://play/x",
  });
});

test("inviteReceived tolerates a missing senderUserId", () => {
  const c = client();
  let got;
  c.on("inviteReceived", (e) => (got = e));
  c._handle({
    meetingInvitationRequestReceivedMessage: { senderUserUuid: "u-2", senderName: "Sam" },
  });
  assert.equal(got.uuid, "u-2");
  assert.equal(got.userId, null);
});

test("acceptMeetingInvitation sends accept:true with the sender uuid", () => {
  const c = client();
  c.acceptMeetingInvitation("u-9");
  assert.deepEqual(c.sent, [
    { meetingInvitationResponseMessage: { accept: true, requestSenderUserUuid: "u-9" } },
  ]);
});

test("playerByUuid resolves a tracked player, else null", () => {
  const c = client();
  c.players.set(3, { userId: 3, name: "Ada", uuid: "u-ada", x: 0, y: 0 });
  assert.equal(c.playerByUuid("u-ada")?.name, "Ada");
  assert.equal(c.playerByUuid("nope"), null);
});

test("invite outcome messages are swallowed without an event or throw", () => {
  const c = client();
  let fired = false;
  c.on("inviteReceived", () => (fired = true));
  assert.doesNotThrow(() => {
    c._handle({ meetingInvitationResponseReceivedMessage: { accepted: true, responderName: "x" } });
    c._handle({ meetingInvitationRequestClosedMessage: {} });
  });
  assert.equal(fired, false);
});
