// Opt-in capture of a listening peer's PCM + transcript events (STT_TEE_DIR,
// issue #61) so real problem audio from a live call can become corpus clips.
// Inert when no directory is given. Writes <dir>/<ts>-<label>.pcm (raw 16 kHz
// mono s16le) and a sibling .jsonl of events, each stamped with the PCM byte
// offset at that moment so a final can be cut back out of the recording.

import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

export class PcmTee {
  constructor(dir, label) {
    this.bytes = 0;
    this.pcmOut = this.eventsOut = null;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(label).replace(/[^\w.-]/g, "_")}`);
    this.pcmOut = createWriteStream(`${base}.pcm`);
    this.eventsOut = createWriteStream(`${base}.jsonl`);
  }

  pcm(buf) {
    if (!this.pcmOut || this.ended) return;
    this.pcmOut.write(buf);
    this.bytes += buf.length;
  }

  event(msg) {
    if (this.ended) return;
    this.eventsOut?.write(JSON.stringify({ ...msg, byteOffset: this.bytes }) + "\n");
  }

  close() {
    if (!this.pcmOut || this.ended) return Promise.resolve();
    this.ended = true;
    return Promise.all([this.pcmOut, this.eventsOut].map((s) => new Promise((r) => s.end(r))));
  }
}
