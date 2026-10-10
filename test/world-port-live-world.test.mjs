import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { LiveWorld } from "../world-port/live/live-world.mjs";

class StubWS extends EventEmitter { close() {} }
const stubFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

test("LiveWorld.close() is idempotent and closes the client once", () => {
  const w = new LiveWorld({ roomUrl: "https://x.test/@/o/w/r", name: "wa-probe-t", fetch: stubFetch, WebSocketImpl: StubWS });
  let n = 0;
  w.client.close = () => { n++; };
  w.close();
  w.close();
  assert.equal(n, 1);
});

test("with RECORD=1, close() saves the recording even if client.close() throws", () => {
  const prev = process.env.RECORD;
  process.env.RECORD = "1";
  let path;
  try {
    const w = new LiveWorld({ roomUrl: "https://x.test/@/o/w/r", name: "wa-probe-rec", fetch: stubFetch, WebSocketImpl: StubWS });
    w.client.close = () => { throw new Error("boom"); };
    assert.throws(() => w.close(), /boom/);
    path = w.recordingPath;
    assert.ok(path && existsSync(path), "recording saved");
    assert.doesNotThrow(() => w.close()); // already closed
  } finally {
    if (prev === undefined) delete process.env.RECORD; else process.env.RECORD = prev;
    if (path) rmSync(path, { force: true });
  }
});
