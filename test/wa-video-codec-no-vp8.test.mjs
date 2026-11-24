// Regression: browsers now offer m=video with H264/VP9 only -- no VP8 -- so a
// VP8-only local video list intersected to nothing and werift threw "negotiate
// codecs failed" before the audio section was reached; every P2P peer in
// "Lean Coffee Table 1" died and `wa sound` 409'd "no one in the bubble to hear
// it". Fixture is the real offer captured live from Calvin's browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RTCPeerConnection } from "werift";
import { PEER_CODECS } from "../src/wa-audio.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(dir, "fixtures", f), "utf8");

for (const f of ["live-browser-offer-no-vp8.sdp", "live-browser-offer-with-video.sdp"]) {
  test(`PEER_CODECS can answer ${f}`, async () => {
    const pc = new RTCPeerConnection({ codecs: PEER_CODECS });
    await pc.setRemoteDescription({ type: "offer", sdp: read(f) });
    const answer = await pc.createAnswer();
    const m = answer.sdp.split(/\r\n|\n/).filter((l) => l.startsWith("m="));
    assert.equal(m.length, 3, "answer mirrors the offer's m= sections");
    pc.close();
  });
}
