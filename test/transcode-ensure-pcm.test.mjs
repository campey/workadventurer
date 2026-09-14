// #8: ensurePcm() — LiveKit's AudioSource.captureFrame() takes raw PCM
// samples directly (no codec, no container), unlike the WEBRTC path which
// demuxes Opus packets. Round-trip test: encode a known-duration tone,
// transcode it, check the byte count lands where a correct sample rate and
// bit depth would put it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePcm } from "../src/transcode.mjs";

const execFileAsync = promisify(execFile);

async function makeToneWav(dir, seconds) {
  const out = path.join(dir, "tone.wav");
  await execFileAsync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-ar", "44100", "-ac", "2",
    out,
  ]);
  return out;
}

test("ensurePcm produces raw s16le mono samples at the requested rate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wa-ensurepcm-test-"));
  try {
    const wav = await makeToneWav(dir, 0.5);
    const pcm = await ensurePcm(wav, { sampleRate: 48000, channels: 1 });
    assert.ok(existsSync(pcm));
    const bytes = statSync(pcm).size;
    // 0.5s @ 48kHz mono s16le = 48000 * 0.5 * 2 bytes, +/- a little for
    // ffmpeg's own resampling/framing rounding.
    const expected = 48000 * 0.5 * 2;
    assert.ok(Math.abs(bytes - expected) < 4000, `${bytes} vs ~${expected}`);
    assert.equal(bytes % 2, 0, "whole 16-bit samples, no trailing partial byte");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensurePcm caches by source + params; different params get different cache entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wa-ensurepcm-test-"));
  try {
    const wav = await makeToneWav(dir, 0.2);
    const a1 = await ensurePcm(wav, { sampleRate: 16000, channels: 1 });
    const a2 = await ensurePcm(wav, { sampleRate: 16000, channels: 1 });
    assert.equal(a1, a2, "same source + params resolves to the same cache entry");

    const b = await ensurePcm(wav, { sampleRate: 48000, channels: 1 });
    assert.notEqual(a1, b, "a different sampleRate gets its own cache entry");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensurePcm throws on a missing source file", async () => {
  await assert.rejects(() => ensurePcm("/no/such/file.wav"), /no such file/);
});
