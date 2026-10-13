// Text -> a stream of Opus packets, for `wa say`.
//
//   say.py --pcm-out  --(24 kHz mono s16le)-->  ffmpeg libopus  --(Ogg)-->  oggOpusPackets
//
// All TTS work (sentence grouping, the cloud call, Mimi decode, QC) happens in
// huggingsesame's say.py; this module only runs it, encodes its PCM and
// guarantees both child processes are gone when the stream ends for any reason
// (finished, error, consumer stopped, signal aborted).

import { spawn } from "node:child_process";
import { oggOpusPackets } from "./ogg-stream.mjs";

// -page_duration 20000 is essential: without it ffmpeg buffers ~1 s of audio
// per Ogg page and the stream stutters out in one-second lumps.
const ffmpegArgs = [
  "-v", "error",
  "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
  "-c:a", "libopus", "-frame_duration", "20",
  "-page_duration", "20000", "-flush_packets", "1",
  "-f", "ogg", "pipe:1",
];

/**
 * @param {string} text
 * @param {{python:string, sayPath:string, voice?:string, backend?:string,
 *          signal?:AbortSignal, ffmpegPath?:string, killGraceMs?:number}} opts
 * @returns {AsyncGenerator<{data: Buffer, samples: number}>}
 */
export async function* speakWebrtc(
  text,
  { python, sayPath, voice, backend = "modal", signal, ffmpegPath = "ffmpeg", killGraceMs = 2000 } = {}
) {
  if (!python || !sayPath) throw new Error("speakWebrtc: python and sayPath are required");
  if (signal?.aborted) return;

  const children = [];
  let spawnError = null;
  let killTimer = null;
  const killAll = (sig) => {
    for (const { c } of children) {
      if (c.pid && c.exitCode === null && c.signalCode === null) c.kill(sig);
    }
  };
  const stopAll = () => {
    killAll("SIGTERM");
    killTimer ??= setTimeout(() => killAll("SIGKILL"), killGraceMs);
  };
  const start = (cmd, args) => {
    const c = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const rec = { c, tail: "", exited: null };
    rec.exited = new Promise((resolve) => {
      c.once("close", (code, sig) => resolve({ code, sig }));
      c.once("error", (e) => {
        spawnError ??= e;
        resolve({ code: -1, sig: null });
        stopAll();
      });
    });
    c.stdin.on("error", () => {}); // EPIPE when the other end died first
    c.stdout.on("error", () => {});
    c.stderr.on("data", (d) => { rec.tail = (rec.tail + d).slice(-2000); });
    children.push(rec);
    return rec;
  };

  // Text goes on stdin ("-"), so quotes, newlines, a leading dash and length
  // limits never touch a shell or argv.
  const sayArgs = [sayPath, "--pcm-out", "--quiet", "--backend", backend, ...(voice ? ["--voice", voice] : []), "-"];
  const say = start(python, sayArgs);
  const ff = start(ffmpegPath, ffmpegArgs);
  // If ffmpeg dies first (no libopus, a crash, a bad flag) nothing reads
  // say.py's stdout any more: it would block on a full pipe and never exit.
  ff.c.once("exit", (code) => {
    if (code !== 0) stopAll();
  });
  const onAbort = () => stopAll();
  signal?.addEventListener("abort", onAbort, { once: true });

  let yielded = 0;
  try {
    say.c.stdout.pipe(ff.c.stdin);
    say.c.stdin.end(text);
    for await (const pkt of oggOpusPackets(ff.c.stdout)) {
      yielded++;
      yield pkt;
    }
    const [s, f] = await Promise.all([say.exited, ff.exited]);
    if (signal?.aborted) return;
    if (spawnError) throw new Error(`speakWebrtc: ${spawnError.message}`);
    const last = (rec) => rec.tail.trim().split("\n").pop();
    // say.py's own failure first; but a say.py we killed (code null) because
    // ffmpeg died is ffmpeg's story.
    if (s.code != null && s.code !== 0) throw new Error(`say.py exited ${s.code}${say.tail.trim() ? `: ${last(say)}` : ""}`);
    if (f.code !== 0) throw new Error(`ffmpeg exited ${f.code ?? f.sig}${ff.tail.trim() ? `: ${last(ff)}` : ""}`);
    if (s.code !== 0) throw new Error(`say.py was killed (${s.sig})`);
    if (!yielded) throw new Error("say.py produced no audio");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stopAll();
    // A child's 'close' waits for every stdio stream to end. After an early stop
    // nobody reads say.py's stdout (ffmpeg's stdin is gone), so it would never
    // end and the await below would hang: destroy the streams ourselves.
    for (const { c } of children) {
      c.stdin.destroy();
      c.stdout.destroy();
      c.stderr.destroy();
    }
    await Promise.all(children.map((r) => r.exited));
    clearTimeout(killTimer);
  }
}
