// Text -> audio for `wa say`, one entry point per transport:
//
//   speakWebrtc  say.py --pcm-out --(24 kHz mono s16le)--> ffmpeg libopus
//                --(Ogg)--> oggOpusPackets      => { data, samples } Opus packets for RTP
//   speakLiveKit say.py --pcm-out --(24 kHz mono s16le)--> ffmpeg resample
//                --(48 kHz mono s16le)--> 20 ms frames => Int16Array(960) for captureFrame
//
// All TTS work (sentence grouping, the cloud call, Mimi decode, QC) happens in
// huggingsesame's say.py; this module only runs it, converts its PCM and
// guarantees both child processes are gone when the stream ends for any reason
// (finished, error, consumer stopped, signal aborted).

import { spawn } from "node:child_process";
import { oggOpusPackets } from "./ogg-stream.mjs";

// -page_duration 20000 is essential: without it ffmpeg buffers ~1 s of audio
// per Ogg page and the stream stutters out in one-second lumps.
const OPUS_FFMPEG_ARGS = [
  "-v", "error",
  "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
  "-c:a", "libopus", "-frame_duration", "20",
  "-page_duration", "20000", "-flush_packets", "1",
  "-f", "ogg", "pipe:1",
];

// LiveKit's AudioSource takes raw PCM at its own rate (48 kHz here), no codec.
const PCM48_FFMPEG_ARGS = [
  "-v", "error",
  "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
  "-f", "s16le", "-ar", "48000", "-ac", "1", "pipe:1",
];
const FRAME_SAMPLES = 960; // 20 ms at 48 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2;

/**
 * Run say.py piped into ffmpeg and yield ffmpeg's stdout as raw chunks. Owns the
 * whole process lifecycle; the speak* wrappers only interpret the bytes.
 * @returns {AsyncGenerator<Buffer>}
 */
async function* runSay(
  label,
  text,
  ffmpegArgs,
  { python, sayPath, voice, backend = "modal", signal, ffmpegPath = "ffmpeg", killGraceMs = 2000 } = {}
) {
  if (!python || !sayPath) throw new Error(`${label}: python and sayPath are required`);
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

  try {
    say.c.stdout.pipe(ff.c.stdin);
    say.c.stdin.end(text);
    for await (const chunk of ff.c.stdout) yield chunk;
    const [s, f] = await Promise.all([say.exited, ff.exited]);
    if (signal?.aborted) return;
    if (spawnError) throw new Error(`${label}: ${spawnError.message}`);
    const last = (rec) => rec.tail.trim().split("\n").pop();
    // say.py's own failure first; but a say.py we killed (code null) because
    // ffmpeg died is ffmpeg's story.
    if (s.code != null && s.code !== 0) throw new Error(`say.py exited ${s.code}${say.tail.trim() ? `: ${last(say)}` : ""}`);
    if (f.code !== 0) throw new Error(`ffmpeg exited ${f.code ?? f.sig}${ff.tail.trim() ? `: ${last(ff)}` : ""}`);
    if (s.code !== 0) throw new Error(`say.py was killed (${s.sig})`);
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

// Re-chunk ffmpeg's arbitrary-sized PCM output into whole 20 ms frames. Each
// frame is a COPY in its own zero-offset buffer: AudioFrame.protoInfo() hands
// the native side `data.buffer` and ignores byteOffset, so a view into a shared
// buffer makes every frame the same first 20 ms (the ~50 Hz buzz of #8). A
// trailing partial frame is zero-padded rather than dropped.
async function* pcmFrames(chunks) {
  let pending = Buffer.alloc(0);
  for await (const chunk of chunks) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let pos = 0;
    while (pending.length - pos >= FRAME_BYTES) {
      yield new Int16Array(pending.buffer.slice(pending.byteOffset + pos, pending.byteOffset + pos + FRAME_BYTES));
      pos += FRAME_BYTES;
    }
    pending = pending.subarray(pos);
  }
  if (pending.length) {
    const padded = Buffer.alloc(FRAME_BYTES);
    pending.copy(padded);
    yield new Int16Array(padded.buffer.slice(padded.byteOffset, padded.byteOffset + FRAME_BYTES));
  }
}

/**
 * Opus packets for the WEBRTC mesh path.
 * @param {string} text
 * @param {{python:string, sayPath:string, voice?:string, backend?:string,
 *          signal?:AbortSignal, ffmpegPath?:string, killGraceMs?:number}} opts
 * @returns {AsyncGenerator<{data: Buffer, samples: number}>}
 */
export async function* speakWebrtc(text, opts = {}) {
  let n = 0;
  for await (const pkt of oggOpusPackets(runSay("speakWebrtc", text, OPUS_FFMPEG_ARGS, opts))) {
    n++;
    yield pkt;
  }
  if (!n && !opts.signal?.aborted) throw new Error("say.py produced no audio");
}

/**
 * 20 ms frames of 48 kHz mono s16le for the LiveKit path (AudioSource.captureFrame).
 * @returns {AsyncGenerator<Int16Array>}  each of length 960, owning its buffer
 */
export async function* speakLiveKit(text, opts = {}) {
  let n = 0;
  for await (const frame of pcmFrames(runSay("speakLiveKit", text, PCM48_FFMPEG_ARGS, opts))) {
    n++;
    yield frame;
  }
  if (!n && !opts.signal?.aborted) throw new Error("say.py produced no audio");
}
