// Minimal Ogg-Opus muxer, the inverse of ogg-opus.mjs. Enough to hand ffmpeg
// something it'll decode — not a general-purpose muxer (no multi-stream
// interleave, no page-size splitting beyond one packet per page).
//
// `OggOpusMuxStream` emits one page per Opus packet, so ffmpeg reading it as a
// pipe can start decoding within ~20ms of the first packet — used by
// src/wa-stt.mjs to stream a peer's live audio into decode+STT with minimal
// added latency. `muxOggOpus` is the batch equivalent (all packets, one file).

// Ogg's CRC-32 variant: poly 0x04c11db7, MSB-first, no reflection, init 0, no
// final xor — different from the IEEE CRC-32 used by zip/png/etc.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    t[n] = c >>> 0;
  }
  return t;
})();
function oggCrc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(n)))); return b; };

function segmentTable(len) {
  const segs = [];
  let rem = len;
  while (rem >= 255) { segs.push(255); rem -= 255; }
  segs.push(rem); // trailing segment, even if 0
  return segs;
}

function buildPage({ serial, pageSeq, granule, packets, headerType }) {
  const segs = [];
  for (const p of packets) segs.push(...segmentTable(p.length));
  if (segs.length > 255) throw new Error("page too big for this simple muxer");
  const header = Buffer.concat([
    Buffer.from("OggS", "latin1"),
    Buffer.from([0]), // version
    Buffer.from([headerType]),
    u64le(granule),
    u32le(serial),
    u32le(pageSeq),
    u32le(0), // crc placeholder
    Buffer.from([segs.length]),
    Buffer.from(segs),
  ]);
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

function opusHeadPacket(channels = 2, sampleRate = 48000) {
  return Buffer.concat([
    Buffer.from("OpusHead", "latin1"),
    Buffer.from([1]), // version
    Buffer.from([channels]),
    u16le(0), // pre-skip
    u32le(sampleRate),
    u16le(0), // output gain
    Buffer.from([0]), // channel mapping family
  ]);
}
function opusTagsPacket() {
  const vendor = Buffer.from("workadventurer", "latin1");
  return Buffer.concat([Buffer.from("OpusTags", "latin1"), u32le(vendor.length), vendor, u32le(0)]);
}

const rnd32 = () => (Math.random() * 0xffffffff) >>> 0;

/** Incremental muxer: one Ogg page per Opus packet, minimal added latency. */
export class OggOpusMuxStream {
  constructor({ channels = 2, sampleRate = 48000, serial } = {}) {
    this.serial = serial ?? rnd32();
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.pageSeq = 0;
    this.granule = 0;
  }

  /** Call once, before any pushPacket() — the two Ogg-Opus header pages. */
  headerPages() {
    const head = buildPage({ serial: this.serial, pageSeq: this.pageSeq++, granule: 0, packets: [opusHeadPacket(this.channels, this.sampleRate)], headerType: 0x02 });
    const tags = buildPage({ serial: this.serial, pageSeq: this.pageSeq++, granule: 0, packets: [opusTagsPacket()], headerType: 0x00 });
    return Buffer.concat([head, tags]);
  }

  /** @param {{data:Buffer, samples:number}} packet -> one Ogg page Buffer */
  pushPacket({ data, samples }) {
    this.granule += samples;
    return buildPage({ serial: this.serial, pageSeq: this.pageSeq++, granule: this.granule, packets: [data], headerType: 0x00 });
  }
}

/** Batch equivalent: mux a whole packet array into one file-ready Buffer. */
export function muxOggOpus(packets, opts = {}) {
  const s = new OggOpusMuxStream(opts);
  return Buffer.concat([s.headerPages(), ...packets.map((p) => s.pushPacket(p))]);
}
