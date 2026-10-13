// Incremental Ogg/Opus demuxer: the streaming sibling of readOggOpus() for
// `wa say`, where ffmpeg's stdout arrives in arbitrary slices while the clip is
// still being generated. Page layout and lacing are documented in
// ogg-opus.mjs; the difference here is that a page is only parsed once all of
// it has arrived, and a packet that ends a page on a 255 lacing value is
// carried into the next page.

import { opusSamples } from "./ogg-opus.mjs";

const isHeader = (data) => {
  const tag = data.toString("latin1", 0, 8);
  return tag === "OpusHead" || tag === "OpusTags";
};

/**
 * @param {AsyncIterable<Buffer>} chunks  raw bytes of an Ogg/Opus stream
 * @returns {AsyncGenerator<{data: Buffer, samples: number}>}
 */
export async function* oggOpusPackets(chunks) {
  let buf = Buffer.alloc(0);
  let carry = null; // partial packet spanning a page boundary
  for await (const chunk of chunks) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    let pos = 0;
    for (;;) {
      if (buf.length - pos < 27) break;
      if (buf.toString("latin1", pos, pos + 4) !== "OggS") {
        throw new Error("bad Ogg stream: missing OggS capture pattern");
      }
      const segCount = buf[pos + 26];
      const headerLen = 27 + segCount;
      if (buf.length - pos < headerLen) break;
      let bodyLen = 0;
      for (let i = 0; i < segCount; i++) bodyLen += buf[pos + 27 + i];
      if (buf.length - pos < headerLen + bodyLen) break;

      let dp = pos + headerLen;
      let parts = carry ? [carry] : [];
      carry = null;
      for (let i = 0; i < segCount; i++) {
        const lace = buf[pos + 27 + i];
        parts.push(buf.subarray(dp, dp + lace));
        dp += lace;
        if (lace < 255) {
          const data = Buffer.concat(parts); // copies, so `buf` can be released
          parts = [];
          if (data.length && !isHeader(data)) yield { data, samples: opusSamples(data) };
        }
      }
      carry = parts.length ? Buffer.concat(parts) : null;
      pos += headerLen + bodyLen;
    }
    buf = buf.subarray(pos);
  }
}
