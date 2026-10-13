// The streaming Ogg/Opus demuxer must agree with the whole-file reader no
// matter how the byte stream is chunked (ffmpeg's pipe delivers arbitrary
// slices), including packets that span lacing values and pages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readOggOpus } from "../src/ogg-opus.mjs";
import { muxOggOpus } from "../src/ogg-opus-mux.mjs";
import { oggOpusPackets } from "../src/ogg-stream.mjs";

async function collect(it) {
  const out = [];
  for await (const p of it) out.push(p);
  return out;
}

async function* chunked(buf, size) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(i + size, buf.length));
}

function assertSame(got, want, label) {
  assert.equal(got.length, want.length, `${label}: packet count`);
  got.forEach((p, i) => {
    assert.ok(p.data.equals(want[i].data), `${label}: packet ${i} bytes`);
    assert.equal(p.samples, want[i].samples, `${label}: packet ${i} samples`);
  });
}

test("matches readOggOpus for a real clip at several chunk sizes", async () => {
  const { packets } = await readOggOpus("sounds/chime.ogg");
  const ogg = muxOggOpus(packets);
  for (const size of [1, 7, 27, 255, 1000, ogg.length]) {
    assertSame(await collect(oggOpusPackets(chunked(ogg, size))), packets, `chunk ${size}`);
  }
});

test("reassembles packets that cross lacing values and exact multiples of 255", async () => {
  const mk = (n, fill) => {
    const data = Buffer.alloc(n, fill);
    data[0] = 0x78; // TOC: 20 ms, code 0 -> 960 samples
    return { data, samples: 960 };
  };
  const packets = [mk(600, 1), mk(255, 2), mk(510, 3), mk(10, 4)];
  const ogg = muxOggOpus(packets);
  for (const size of [1, 13, 300, ogg.length]) {
    assertSame(await collect(oggOpusPackets(chunked(ogg, size))), packets, `chunk ${size}`);
  }
});

test("a truncated tail yields the complete packets and does not throw", async () => {
  const { packets } = await readOggOpus("sounds/chime.ogg");
  const ogg = muxOggOpus(packets);
  const got = await collect(oggOpusPackets(chunked(ogg.subarray(0, ogg.length - 5), 100)));
  assert.ok(got.length > 0 && got.length < packets.length);
  assertSame(got, packets.slice(0, got.length), "prefix");
});

test("non-Ogg input throws a clear error", async () => {
  await assert.rejects(
    collect(oggOpusPackets(chunked(Buffer.from("this is not an ogg stream at all!"), 10))),
    /bad Ogg/
  );
});
