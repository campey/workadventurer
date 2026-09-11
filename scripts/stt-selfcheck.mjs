// Live smoke test for the STT pipeline (issue #23): mux + ffmpeg decode +
// resident-model worker + live correction, driven by a real Opus clip (no WA
// connection, no peer needed — SttStream itself is what's under test).
//
//   node scripts/stt-selfcheck.mjs [path/to/clip.wav]
//
// Requires ffmpeg and python3 + mlx_whisper on PATH (the latter installs the
// tiny model on first run — expect a one-time download).

import { SttStream } from "../src/wa-stt.mjs";
import { ensureOpus } from "../src/transcode.mjs";
import { readOggOpus } from "../src/ogg-opus.mjs";

const clip = process.argv[2] ?? "/Users/campey/Code/huggingsesame/claude_intro_v2.wav";

console.log(`clip: ${clip}`);
const opusFile = await ensureOpus(clip);
const { packets, totalSamples } = await readOggOpus(opusFile);
console.log(`packets: ${packets.length}  duration: ${(totalSamples / 48000).toFixed(2)}s`);

const stream = new SttStream();
let failed = false;
stream.on("error", (e) => {
  failed = true;
  console.log(`FAIL  worker/pipeline error: ${e.message}`);
});
stream.on("log", (m) => {
  if (/error|assertion|exited/i.test(m)) console.log(`FAIL  ${m}`);
});

const t0 = Date.now();
let firstPartialAt = null;
let lastText = "";
stream.on("partial", (m) => {
  if (firstPartialAt === null) firstPartialAt = Date.now() - t0;
  lastText = m.text;
  process.stdout.write(`\r\x1b[K[+${((Date.now() - t0) / 1000).toFixed(2)}s] partial: ${m.text}`);
});
let finalText = null;
stream.on("final", (m) => {
  finalText = m.text;
  console.log(`\n[+${((Date.now() - t0) / 1000).toFixed(2)}s] FINAL: ${m.text}`);
});

// stream at real-time pace, like RTP arriving live
let i = 0;
await new Promise((resolve) => {
  const iv = setInterval(() => {
    if (i >= packets.length) {
      clearInterval(iv);
      resolve();
      return;
    }
    stream.push(packets[i++]);
  }, 20);
});

console.log("done streaming — closing (final flush can take a few seconds)...");
const gotFinal = new Promise((resolve) => stream.once("final", () => resolve(true)));
stream.close();
await Promise.race([gotFinal, new Promise((r) => setTimeout(() => r(false), 8000))]);

console.log("\n--- result ---");
console.log(`PASS  first partial at ${firstPartialAt === null ? "never" : (firstPartialAt / 1000).toFixed(2) + "s"}`);
console.log(`${finalText ? "PASS" : "FAIL"}  final: ${finalText ?? "(none — worker never flushed within 8s of close())"}`);
console.log(`(last partial seen: ${lastText || "(none)"})`);
console.log(failed || !finalText ? "\nFAIL" : "\nOK");
process.exit(failed || !finalText ? 1 : 0);
