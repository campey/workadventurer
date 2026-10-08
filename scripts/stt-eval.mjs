// STT quality eval (issue #61): runs every clip in test/fixtures/stt/ through
// the real pipeline (SttStream -> ffmpeg -> resident worker) and scores the
// finals against test/fixtures/stt/expected.json, so a change to the worker's
// gates/model/language is compared by numbers, not by ear.
//
//   node scripts/stt-eval.mjs [--fast] [--repeat N] [--only substr] [--max-wer 0.25] [--json out.json]
//
// Worker knobs travel by environment (inherited by the spawned worker), e.g.
//   STT_LANGUAGE=en node scripts/stt-eval.mjs
//
// Clips stream at real-time RTP pace by default so silence-gap finalization
// behaves as live; --fast pushes packets back to back (finals then come from
// the close() flush). Exit status is non-zero when any gate trips:
//   mean WER over speech clips > --max-wer, or any spurious final / non-Latin
//   output / token loop anywhere.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SttStream, stopWorker } from "../src/wa-stt.mjs";
import { ensureOpus } from "../src/transcode.mjs";
import { readOggOpus } from "../src/ogg-opus.mjs";
import { scoreClip } from "../src/stt-score.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const fast = flag("fast");
const only = opt("only", "");
const maxWer = Number(opt("max-wer", "0.25"));
const jsonOut = opt("json", null);
const repeat = Number(opt("repeat", "1")); // decoding is sampled (temperature fallback), so one pass is noisy

// test/fixtures/stt/ is committed (synthetic); test/fixtures/stt-real/ is a
// local-only corpus of real call audio (people's voices — never committed).
// In expected.json, "" = must produce nothing, null = no reference (script/loop
// checks only), anything else = reference text for WER.
const dirs = ["stt", "stt-real"]
  .map((d) => fileURLToPath(new URL(`../test/fixtures/${d}/`, import.meta.url)))
  .filter((d) => existsSync(path.join(d, "expected.json")));
const expected = {};
const clipPath = {};
for (const d of dirs) {
  for (const [clip, text] of Object.entries(JSON.parse(readFileSync(path.join(d, "expected.json"), "utf8")))) {
    expected[clip] = text;
    clipPath[clip] = path.join(d, clip);
  }
}
const clips = Object.keys(expected).filter((c) => c.includes(only));

async function runClip(file) {
  const { packets } = await readOggOpus(await ensureOpus(file));
  const stream = new SttStream();
  const finals = [];
  let error = null;
  stream.on("final", (m) => finals.push(m.text));
  stream.on("error", (e) => (error = e));
  const t0 = Date.now();
  for (const p of packets) {
    stream.push(p);
    if (!fast) await new Promise((r) => setTimeout(r, 20));
  }
  // Give a silence-gap final time to land, then close to flush the remainder.
  if (!fast) await new Promise((r) => setTimeout(r, 1500));
  stream.close();
  await new Promise((r) => setTimeout(r, 4000)); // close-flush final
  return { finals, error, ms: Date.now() - t0 };
}

const rows = [];
for (const clip of clips.flatMap((c) => Array(repeat).fill(c))) {
  const { finals, error, ms } = await runClip(clipPath[clip]);
  rows.push({ clip, expected: expected[clip], ...scoreClip({ expected: expected[clip], finals }), finals, error: error?.message, ms });
}
stopWorker();

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad("clip", 26)} ${pad("wer", 5)} ${pad("spur", 4)} ${pad("nonL", 4)} ${pad("loop", 4)} text`);
for (const r of rows) {
  const w = r.wer === null ? "-" : r.wer.toFixed(2);
  console.log(`${pad(r.clip, 26)} ${pad(w, 5)} ${pad(r.spurious, 4)} ${pad(r.nonLatin ? "X" : ".", 4)} ${pad(r.loop ? "X" : ".", 4)} ${JSON.stringify(r.text.length > 110 ? r.text.slice(0, 110) + `…(+${r.text.length - 110})` : r.text)}${r.error ? "  ERROR " + r.error : ""}`);
}

const speech = rows.filter((r) => r.wer !== null);
const meanWer = speech.length ? speech.reduce((a, r) => a + r.wer, 0) / speech.length : 0;
const spurious = rows.reduce((a, r) => a + r.spurious, 0);
const nonLatin = rows.filter((r) => r.nonLatin).length;
const loops = rows.filter((r) => r.loop).length;
const errors = rows.filter((r) => r.error).length;
console.log(`\nmean WER ${meanWer.toFixed(3)} (${speech.length} speech clips)  spurious finals ${spurious}  non-Latin ${nonLatin}  loops ${loops}  errors ${errors}`);

if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ meanWer, spurious, nonLatin, loops, rows }, null, 2));
const bad = meanWer > maxWer || spurious || nonLatin || loops || errors;
console.log(bad ? "FAIL" : "OK");
process.exit(bad ? 1 : 0);
