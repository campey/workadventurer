// Lists the finals in a STT_TEE_DIR capture with the PCM span each covers, and
// optionally cuts a span out as a corpus clip (issue #61).
//
//   node scripts/stt-tee-list.mjs <dir>
//   node scripts/stt-tee-list.mjs <dir> --cut <recording-basename> <n> <out.wav>
//
// A final's audio runs from the previous final's byteOffset to its own; <n> is
// the index shown in the listing. 1.5 s of silence is appended so the worker
// finalizes on a silence gap, like the other corpus clips.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [dir, flag, base, nStr, out] = process.argv.slice(2);
const spans = (jsonl) => {
  let prev = 0;
  return readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean).map((l, i) => {
    const e = JSON.parse(l);
    const s = { i, from: prev, to: e.byteOffset, text: e.text };
    prev = e.byteOffset;
    return s;
  });
};

if (flag === "--cut") {
  const s = spans(path.join(dir, `${base}.jsonl`))[Number(nStr)];
  const pcm = readFileSync(path.join(dir, `${base}.pcm`)).subarray(s.from, s.to);
  const raw = path.join(dir, `.cut-${process.pid}.pcm`);
  writeFileSync(raw, Buffer.concat([pcm, Buffer.alloc(48000)]));
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", raw, "-c:a", "pcm_s16le", out]);
  if (r.status) throw new Error(r.stderr.toString());
  console.log(`wrote ${out} (${((s.to - s.from) / 32000).toFixed(1)}s) — transcribed as ${JSON.stringify(s.text)}`);
} else {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    console.log(`== ${f.replace(/\.jsonl$/, "")}`);
    for (const s of spans(path.join(dir, f))) {
      console.log(`${String(s.i).padStart(3)}  ${(s.from / 32000).toFixed(1).padStart(6)}-${(s.to / 32000).toFixed(1).padEnd(6)}s  ${JSON.stringify(s.text)}`);
    }
  }
}
