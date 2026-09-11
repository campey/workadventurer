// Live speech-to-text for a peer's inbound proximity-voice audio (issue #23).
//
// Pipeline per listening peer:
//   peer's Opus RTP  --(OggOpusMuxStream)-->  Ogg pages
//                     --(ffmpeg, persistent)-->  16kHz mono PCM
//                     --(Unix socket)-->  scripts/stt_worker.py (resident model)
//                     <--(JSON lines)--  {type:"partial"|"final", text, words}
//
// The worker process is a singleton per daemon (model load is the expensive
// part); each peer that needs STT opens its own socket connection to it — the
// connection *is* the channel, no multiplexing/ids needed on the wire.

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import { OggOpusMuxStream } from "./ogg-opus-mux.mjs";

const SOCK_PATH = fileURLToPath(new URL("../.wa-stt.sock", import.meta.url));
const WORKER_SCRIPT = fileURLToPath(new URL("../scripts/stt_worker.py", import.meta.url));

let workerProc = null;
let workerReady = null; // Promise, resolves once the socket is accepting connections

/** Start the resident STT worker if it isn't already running. Idempotent. */
function ensureWorker(log = () => {}) {
  if (workerReady) return workerReady;
  workerReady = new Promise((resolve, reject) => {
    try {
      if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
    } catch {}
    const proc = spawn("python3", [WORKER_SCRIPT, "--socket", SOCK_PATH], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    workerProc = proc;
    let settled = false;
    proc.stderr.on("data", (c) => {
      const line = c.toString().trim();
      if (line) log(`stt-worker: ${line}`);
      if (!settled && /listening on/.test(line)) {
        settled = true;
        resolve();
      }
    });
    proc.on("error", (e) => {
      if (!settled) { settled = true; reject(e); }
    });
    proc.on("exit", (code) => {
      log(`stt-worker exited (${code})`);
      workerProc = null;
      workerReady = null;
      if (!settled) { settled = true; reject(new Error(`stt-worker exited ${code} before starting`)); }
    });
    setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("stt-worker startup timeout")); }
    }, 15000);
  });
  return workerReady;
}

export function stopWorker() {
  workerProc?.kill();
  workerProc = null;
  workerReady = null;
}

/**
 * Live-transcribes one peer's inbound audio. Feed Opus RTP packets with
 * `push({data, samples})`; listen for `partial` / `final` ({text, words}) and
 * `error`. `close()` tears everything down.
 */
export class SttStream extends EventEmitter {
  constructor({ channels = 2, sampleRate = 48000 } = {}) {
    super();
    this.mux = new OggOpusMuxStream({ channels, sampleRate });
    this.ffmpeg = null;
    this.sock = null;
    this._buf = "";
    this._closed = false;
    this._gotAnyData = false;
    this._start().catch((e) => this.emit("error", e));
  }

  async _start(attempt = 1) {
    await ensureWorker((m) => this.emit("log", m));
    if (this._closed) return;

    // Occasionally the very first connection attempt right after the worker
    // reports ready produces nothing at all (no error, no data) — a startup
    // race we haven't fully pinned down. One clean retry papers over it.
    setTimeout(() => {
      if (!this._closed && !this._gotAnyData && attempt === 1) {
        this.emit("log", "no data within 3s of connecting — retrying once");
        try { this.ffmpeg?.kill(); } catch {}
        try { this.sock?.destroy(); } catch {}
        this._start(2).catch((e) => this.emit("error", e));
      }
    }, 3000);

    this.ffmpeg = spawn("ffmpeg", [
      "-v", "error",
      // Force the input format and skip probing/analysis — otherwise ffmpeg
      // buffers a large chunk before it starts decoding, which turns this
      // into a "wait a few seconds then dump a burst" pipe instead of a live
      // stream.
      "-fflags", "nobuffer", "-flags", "low_delay",
      "-f", "ogg", "-i", "pipe:0",
      "-f", "s16le", "-ar", "16000", "-ac", "1", "-flush_packets", "1",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.ffmpeg.stderr.on("data", (c) => this.emit("log", `ffmpeg: ${c.toString().trim()}`));
    this.ffmpeg.on("error", (e) => this.emit("error", e));

    this.sock = net.createConnection(SOCK_PATH);
    this.sock.on("error", (e) => this.emit("error", e));
    this.sock.on("data", (chunk) => this._onSockData(chunk));

    this.ffmpeg.stdout.pipe(this.sock);
    this.ffmpeg.stdin.write(this.mux.headerPages());
  }

  _onSockData(chunk) {
    this._gotAnyData = true;
    this._buf += chunk.toString("utf8");
    let nl;
    while ((nl = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this.emit(msg.type, msg); // "partial" | "final"
      } catch (e) {
        this.emit("log", `stt parse error: ${e.message}`);
      }
    }
  }

  /** @param {{data:Buffer, samples:number}} packet a decoded Opus RTP payload */
  push(packet) {
    if (this._closed || !this.ffmpeg?.stdin?.writable) return;
    try {
      this.ffmpeg.stdin.write(this.mux.pushPacket(packet));
    } catch (e) {
      this.emit("log", `stt push error: ${e.message}`);
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    // End ffmpeg's stdin and let it drain + exit on its own — killing it
    // immediately truncates whatever it hasn't flushed yet, which cuts off
    // the tail of the last utterance and the socket EOF that triggers the
    // worker's final flush.
    try {
      this.ffmpeg?.stdin?.end();
      const proc = this.ffmpeg;
      const killTimer = setTimeout(() => { try { proc?.kill(); } catch {} }, 3000);
      proc?.once("exit", () => clearTimeout(killTimer));
    } catch {}
    setTimeout(() => { try { this.sock?.end(); } catch {} }, 3200);
  }
}
