// Make any audio file playable by `wa sound`: pass Opus-in-Ogg straight
// through, transcode everything else with ffmpeg (optional external tool).
//
// The RTP path in wa-audio.mjs demuxes Opus packets directly — no decode — so
// the clip must be Opus in an Ogg container. This bridges the gap for mp3 / wav
// / m4a / ogg-vorbis / … without adding an npm dependency.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const CACHE_DIR = path.join(os.tmpdir(), "wa-sound-cache");

// True if the first Ogg page of `file` is an Opus identification header.
async function isOpusOgg(file) {
  return new Promise((resolve) => {
    const s = createReadStream(file, { start: 0, end: 63 });
    const chunks = [];
    s.on("data", (c) => chunks.push(c));
    s.on("error", () => resolve(false));
    s.on("end", () => {
      const b = Buffer.concat(chunks);
      resolve(b.length >= 32 && b.toString("latin1", 0, 4) === "OggS" && b.includes("OpusHead"));
    });
  });
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    let ff;
    try {
      ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    let err = "";
    ff.stderr.on("data", (c) => (err += c));
    ff.on("error", (e) =>
      reject(
        e.code === "ENOENT"
          ? new Error("ffmpeg not found — install it, or pass an .ogg/.opus file")
          : e
      )
    );
    ff.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split("\n").pop()}`))
    );
  });
}

/**
 * Return a path to an Opus-in-Ogg version of `srcPath`, transcoding via ffmpeg
 * if needed. Results are cached in the OS temp dir, keyed by the source's
 * path + mtime + size, so repeat plays don't re-run ffmpeg.
 */
export async function ensureOpus(srcPath) {
  const src = path.resolve(srcPath);
  if (!existsSync(src)) throw new Error(`no such file: ${src}`);

  if (/\.(ogg|opus)$/i.test(src) && (await isOpusOgg(src))) return src;

  const st = await stat(src);
  const key = crypto
    .createHash("sha1")
    .update(`${src}\0${st.mtimeMs}\0${st.size}`)
    .digest("hex")
    .slice(0, 16);
  const out = path.join(CACHE_DIR, `${key}.ogg`);
  if (existsSync(out)) return out;

  await mkdir(CACHE_DIR, { recursive: true });
  await ffmpeg([
    "-v", "error", "-y",
    "-i", src,
    "-c:a", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "2",
    "-frame_duration", "20",
    "-f", "ogg", out,
  ]);
  return out;
}
