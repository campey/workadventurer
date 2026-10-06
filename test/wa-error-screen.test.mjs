// Issue #56: a server errorScreenMessage used to surface as
// "server error screen: [object Object] / [object Object]" (the proto's
// StringValue wrappers were interpolated without `.value`), and nothing told
// callers the server had said "don't retry" (NEW_VERSION, timeToRetry 999999).

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";
import { ServerRejectedError, isVersionRejection } from "../src/server-rejected.mjs";
import { startFakePusher } from "./helpers/fake-pusher.mjs";

async function connectAgainst(opts) {
  const pusher = await startFakePusher(opts);
  const client = new WorkAdventureClient({
    name: "t",
    roomUrl: pusher.roomUrl,
    pusherUrl: pusher.url,
    target: "wa-1.34",
  });
  try {
    await client.connect();
    assert.fail("connect() should have rejected");
  } catch (e) {
    return e;
  } finally {
    try { client.close(); } catch {}
    await pusher.close();
  }
}

test("NEW_VERSION error screen: readable message naming code and text, no [object Object]", async () => {
  const e = await connectAgainst();
  assert.ok(e instanceof ServerRejectedError, `got ${e?.constructor?.name}: ${e?.message}`);
  assert.equal(
    e.message,
    "server error screen: Please refresh — A new version of WorkAdventure is available (NEW_VERSION)"
  );
  assert.equal(e.code, "NEW_VERSION");
  assert.equal(e.retryable, false);
});

test("an unknown error code with a normal timeToRetry stays retryable", async () => {
  const e = await connectAgainst({ code: "SOMETHING_ELSE", timeToRetry: 30 });
  assert.ok(e instanceof ServerRejectedError);
  assert.equal(e.code, "SOMETHING_ELSE");
  assert.equal(e.retryable, true);
});

test("a very large timeToRetry means don't auto-retry, whatever the code", async () => {
  const e = await connectAgainst({ code: "SOMETHING_ELSE", timeToRetry: 999999 });
  assert.equal(e.retryable, false);
});

test("isVersionRejection keys on the code, not on the message text", () => {
  assert.equal(isVersionRejection(new ServerRejectedError({ code: "NEW_VERSION" })), true);
  assert.equal(isVersionRejection(new ServerRejectedError({ code: "OTHER", title: "version" })), false);
  assert.equal(isVersionRejection(new Error("new version")), false);
});
