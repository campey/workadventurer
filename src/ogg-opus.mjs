// Minimal Ogg reader: pull the raw Opus packets out of an .ogg / .opus file so
// they can be re-packetised as RTP. Demux only — no decoding, no dependency.
//
// Ogg page layout (RFC 3533):
//   "OggS" | ver(1) | headerType(1) | granulePos(8 LE) | serial(4 LE) |
//   pageSeq(4 LE) | crc(4 LE) | segCount(1) | segTable(segCount) | data…
// A packet is the concatenation of consecutive segments; a lacing value < 255
// ends the packet, 255 means "continues in the next segment".
//
// Opus-in-Ogg (RFC 7845): the first two packets are the "OpusHead" and
// "OpusTags" headers — skipped here. Every packet after that is audio.

import { readFile } from "node:fs/promises";

// Frame duration (ms) from the Opus TOC byte, per RFC 6716 Table 2.
function tocFrameMs(toc) {
  const config = toc >> 3;
  if (config < 12) return [10, 20, 40, 60][config & 3];
  if (config < 16) return [10, 20][config & 1];
  return [2.5, 5, 10, 20][config & 3];
}

// Number of Opus frames in the packet, from the TOCframe-count code (bits 0-1).
function tocFrameCount(pkt) {
  const code = pkt[0] & 3;
  if (code === 0) return 1;
  if (code === 1 || code === 2) return 2;
  return pkt.length > 1 ? pkt[1] & 0x3f : 1; // code 3: count in the next byte
}

function opusSamples(pkt) {
  // 48 kHz clock -> 48 samples per ms.
  return Math.round(48 * tocFrameMs(pkt[0]) * tocFrameCount(pkt));
}

/**
 * @param {string} file  path to an .ogg/.opus (Opus-in-Ogg) file
 * @returns {Promise<{packets: {data: Buffer, samples: number}[], totalSamples: number}>}
 */
export async function readOggOpus(file) {
  const buf = await readFile(file);
  const packets = [];
  let pos = 0;
  let carry = null; // partial packet spanning a page boundary

  while (pos + 27 <= buf.length) {
    if (buf.toString("latin1", pos, pos + 4) !== "OggS") {
      throw new Error(`bad Ogg page at ${pos} in ${file}`);
    }
    const segCount = buf[pos + 26];
    const segTable = buf.subarray(pos + 27, pos + 27 + segCount);
    let dp = pos + 27 + segCount;
    let seg = 0;
    while (seg < segCount) {
      const chunks = carry ? [carry] : [];
      carry = null;
      let lace = 255;
      while (seg < segCount && (lace = segTable[seg++]) === 255) {
        chunks.push(buf.subarray(dp, dp + 255));
        dp += 255;
      }
      if (lace !== 255) {
        chunks.push(buf.subarray(dp, dp + lace));
        dp += lace;
        const data = Buffer.concat(chunks);
        if (data.length) packets.push(data);
      } else {
        // page ended mid-packet — stash and continue on the next page
        carry = Buffer.concat(chunks);
      }
    }
    pos = dp;
  }

  // Drop the two Opus header packets (OpusHead, OpusTags).
  const audio = packets
    .filter((p) => p.length && !p.subarray(0, 8).equals(Buffer.from("OpusHead")) &&
      !p.subarray(0, 8).equals(Buffer.from("OpusTags")))
    .map((data) => ({ data, samples: opusSamples(data) }));

  return {
    packets: audio,
    totalSamples: audio.reduce((n, p) => n + p.samples, 0),
  };
}
