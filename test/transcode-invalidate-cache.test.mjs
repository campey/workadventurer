// #10: a corrupt/truncated cache entry (e.g. from a killed ffmpeg) must not
// poison the mic-prime path forever — invalidateCache() clears it so the next
// call re-encodes. It must never touch a file outside our own cache dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { invalidateCache, silenceOpusFile } from "../src/transcode.mjs";

const CACHE_DIR = path.join(os.tmpdir(), "wa-sound-cache");

test("invalidateCache deletes a file under the cache dir", async () => {
  await mkdir(CACHE_DIR, { recursive: true });
  const victim = path.join(CACHE_DIR, "corrupt-test-entry.ogg");
  await writeFile(victim, ""); // simulate a truncated/empty transcode result

  await invalidateCache(victim);

  assert.equal(existsSync(victim), false);
});

test("invalidateCache refuses to touch a file outside the cache dir", async () => {
  const outside = path.join(os.tmpdir(), "wa-test-not-cache", "keep-me.ogg");
  await mkdir(path.dirname(outside), { recursive: true });
  await writeFile(outside, "not cache content");

  await invalidateCache(outside);

  assert.equal(existsSync(outside), true, "a caller-supplied file must survive");
  await rm(path.dirname(outside), { recursive: true, force: true });
});

test("invalidateCache is a silent no-op for a file that doesn't exist", async () => {
  await assert.doesNotReject(() => invalidateCache(path.join(CACHE_DIR, "never-existed.ogg")));
});

test("a real cache entry can be regenerated after invalidation", async () => {
  const first = await silenceOpusFile(0.9); // distinct duration — its own cache key
  assert.ok(existsSync(first));

  await invalidateCache(first);
  assert.equal(existsSync(first), false);

  const second = await silenceOpusFile(0.9); // same key — must re-encode, not fail
  assert.equal(second, first, "same cache path, regenerated");
  assert.ok(existsSync(second));
});
