// Round-trips a real clip's Opus packets through the muxer and back via
// ffmpeg, so a CRC/framing regression fails loudly instead of just producing
// silent garbage the STT pipeline swallows. Needs ffmpeg on PATH — skips
// itself (not a failure) if it isn't.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readOggOpus } from "../src/ogg-opus.mjs";
import { muxOggOpus, OggOpusMuxStream } from "../src/ogg-opus-mux.mjs";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("muxOggOpus round-trips through ffprobe/ffmpeg with the source duration", { skip: !hasFfmpeg }, async () => {
  const { packets, totalSamples } = await readOggOpus("sounds/chime.ogg");
  const buf = muxOggOpus(packets);

  const dir = mkdtempSync(path.join(tmpdir(), "ogg-mux-test-"));
  try {
    const oggPath = path.join(dir, "remux.ogg");
    writeFileSync(oggPath, buf);

    const info = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-show_entries", "stream=codec_name,sample_rate,channels",
      "-of", "default=noprint_wrappers=1",
      oggPath,
    ]).toString();

    assert.match(info, /codec_name=opus/);
    assert.match(info, /sample_rate=48000/);
    assert.match(info, /channels=2/);
    const durMatch = info.match(/duration=([\d.]+)/);
    assert.ok(durMatch, "ffprobe reported a duration");
    const expectedSeconds = totalSamples / 48000;
    assert.ok(
      Math.abs(Number(durMatch[1]) - expectedSeconds) < 0.05,
      `duration ${durMatch[1]} should match source ${expectedSeconds.toFixed(2)}`
    );

    const wavPath = path.join(dir, "remux.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", oggPath, wavPath]);
    const wavInfo = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1",
      wavPath,
    ]).toString();
    assert.match(wavInfo, /duration=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OggOpusMuxStream emits one page per pushPacket, in order", async () => {
  const { packets } = await readOggOpus("sounds/chime.ogg");
  const s = new OggOpusMuxStream();
  const header = s.headerPages();
  assert.ok(header.length > 0);
  assert.equal(header.toString("latin1", 0, 4), "OggS", "header starts with an Ogg page");

  const pages = packets.slice(0, 5).map((p) => s.pushPacket(p));
  for (const page of pages) {
    assert.equal(page.toString("latin1", 0, 4), "OggS");
  }
  // page sequence numbers increase monotonically (2 header pages, then audio)
  const seqOf = (page) => page.readUInt32LE(18);
  const seqs = pages.map(seqOf);
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1);
});

test("muxOggOpus on an empty packet list still produces valid headers", () => {
  const buf = muxOggOpus([]);
  assert.equal(buf.toString("latin1", 0, 4), "OggS");
});
