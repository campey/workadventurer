import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveClip, SOUNDS_DIR } from "../src/resolve-clip.mjs";

test("bare name finds a bundled non-ogg clip (claude_intro.wav)", () => {
  assert.equal(resolveClip("claude_intro"), path.join(SOUNDS_DIR, "claude_intro.wav"));
});

test("bare name still finds a bundled .ogg clip (chime.ogg)", () => {
  assert.equal(resolveClip("chime"), path.join(SOUNDS_DIR, "chime.ogg"));
});

test("bare name with no matching file falls back to <name>.ogg for the 404 message", () => {
  assert.equal(resolveClip("nonexistent"), path.join(SOUNDS_DIR, "nonexistent.ogg"));
});

test("path with a slash resolves relative to cwd, untouched", () => {
  assert.equal(resolveClip("clips/foo.wav", "/tmp"), path.resolve("/tmp", "clips/foo.wav"));
});

test("absolute path passes through", () => {
  assert.equal(resolveClip("/abs/foo.mp3"), "/abs/foo.mp3");
});
