// #8: a live ~50Hz buzz on every published clip longer than one frame traced
// back to @livekit/rtc-node's AudioFrame.protoInfo(), which hands the native
// FFI side `this.data.buffer` directly, ignoring the typed array's own
// byteOffset/length. A `.subarray()` chunk is a *view* sharing the whole
// clip's single underlying buffer, so every chunk's data pointer resolved to
// byte 0 of the entire clip regardless of loop index -- every 20ms frame
// sent was actually the same first 20ms, repeated 50 times a second. Fix:
// `.slice()` instead of `.subarray()` for the chunk -- for a plain
// `Int16Array` (unlike Node's `Buffer`), `.slice()` copies into a fresh,
// independent, zero-offset buffer, which is what this FFI binding needs.
//
// This test doesn't touch the real SDK (heavy, native, requires a live
// room) -- it locks in the general principle directly: a chunk taken via
// `.slice()` must have its own buffer, whole and zero-offset, not an alias
// into the source's buffer at some nonzero offset.

import { test } from "node:test";
import assert from "node:assert/strict";

test(".slice() chunks have their own independent, zero-offset buffer", () => {
  const samples = new Int16Array([10, 20, 30, 40, 50, 60]);
  const chunk = samples.slice(2, 4); // [30, 40]

  assert.notEqual(chunk.buffer, samples.buffer, "must not alias the source buffer");
  assert.equal(chunk.byteOffset, 0, "the chunk's own buffer must start at byte 0");
  assert.equal(chunk.length, 2);
  assert.deepEqual([...chunk], [30, 40]);

  // The exact failure mode: naively reading `chunk.buffer` from byte 0 (as
  // AudioFrame.protoInfo() does) must reproduce the chunk's own data, not
  // some other part of the original array.
  const rawView = new Int16Array(chunk.buffer);
  assert.deepEqual([...rawView], [30, 40]);
});

test(".subarray() chunks alias the source buffer -- the bug this replaces", () => {
  const samples = new Int16Array([10, 20, 30, 40, 50, 60]);
  const chunk = samples.subarray(2, 4); // view: [30, 40], but...

  assert.equal(chunk.buffer, samples.buffer, "subarray shares the source's buffer (the footgun)");
  assert.notEqual(chunk.byteOffset, 0, "the view starts partway into that shared buffer");

  // Reading `chunk.buffer` from byte 0 -- what AudioFrame.protoInfo() does,
  // ignoring byteOffset entirely -- silently recovers the *start* of the
  // whole original array instead of this chunk's actual data. This is
  // exactly how every 20ms frame ended up sending the clip's first 20ms.
  const rawView = new Int16Array(chunk.buffer);
  assert.deepEqual([...rawView], [10, 20, 30, 40, 50, 60]);
  assert.notDeepEqual([...rawView.slice(0, 2)], [30, 40]);
});
