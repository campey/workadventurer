// #185: the handshake sends the hash the server announced when it is one of the chosen
// adapter's own, not blindly apiVersionHashes[0] (the v1.34.2 rollback: 62e25483 is wa-1.34's
// second hash, known but refused). And the pre-flight's probed hash reaches the daemon's
// client, so a failed home-page GET cannot lose it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";
import { startFakePusher } from "./helpers/fake-pusher.mjs";

const ROLLBACK = "62e25483"; // in wa-1.34's list, not first

const connectOnce = async (opts, pusherOpts) => {
  const pusher = await startFakePusher(pusherOpts);
  const c = new WorkAdventureClient({ name: "t", pusherUrl: pusher.url, roomUrl: pusher.roomUrl, ...opts(pusher) });
  try {
    await c.connect();
    return pusher.stats.versions.slice();
  } finally {
    try { c.close(); } catch {}
    await pusher.close();
  }
};

test("the handshake sends the probed hash when it is a non-first hash of the chosen adapter (rollback)", async () => {
  const versions = await connectOnce(() => ({}), { acceptHashes: [ROLLBACK] });
  assert.deepEqual(versions, [ROLLBACK]);
});

test("a first hash is still sent as before", async () => {
  const versions = await connectOnce(() => ({}), { acceptHashes: ["f4cfe455"] });
  assert.deepEqual(versions, ["f4cfe455"]);
});

test("an unknown probed hash is not sent: the adapter's own first hash is", async () => {
  const versions = await connectOnce(() => ({}), { acceptHashes: ["f4cfe455"], pageHash: "5ec0de01" });
  assert.deepEqual(versions, ["f4cfe455"]); // the server takes wa-1.34's own hash; the unknown announced one is never sent
});

test("probedHint from the pre-flight is used when the home page cannot be read", async () => {
  const versions = await connectOnce(
    () => ({ probedHint: ROLLBACK, roomUrl: "http://127.0.0.1:1/@/a/b/c" }), // nothing listens there: the probe fails
    { acceptHashes: [ROLLBACK] }
  );
  assert.deepEqual(versions, [ROLLBACK]);
});
