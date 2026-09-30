// Integration proof against real werift, using the exact SDP captured live
// from a real WA browser client (David, single player, "Blue table" named
// area) at the moment the bug reproduced.
//
// Root cause: a real WA browser peer's offer always includes an m=video
// section, even with the camera off. Our RTCPeerConnection only ever
// declared an audio codec (`codecs: { audio: [OPUS] }`) -- but werift's
// TransceiverManager.setRemoteRTP() throws unconditionally whenever a media
// section's codec list, filtered against our local config, comes up empty.
// It doesn't distinguish "we don't support this kind at all" from "we do
// but nothing overlapped" -- so the offer's m=video section (which sorts
// before m=audio in a real browser's SDP) threw before the perfectly
// compatible audio section right after it was ever processed, killing the
// whole peer connection. Reproduced live: single real peer, answer path
// (initiator=false), "negotiate codecs failed", then /sound 409'd with
// "no one in the bubble to hear it" even though someone was right there.
//
// Fix: declare `video: [useVP8()]` too -- matching werift's own
// generateDefaultPeerConfig() default, which our previous `{ audio: [OPUS]
// }` override had silently dropped. We never add our own video
// transceiver, so werift auto-creates a recvonly one for the remote's
// m=video section and nothing downstream ever reads from it -- this is
// purely to let codec negotiation for that section succeed instead of
// throwing.
//
// An earlier attempt at this fix stripped the m=video section out of the
// SDP text entirely before handing it to werift. That avoided the codec
// throw but broke WebRTC's required positional correspondence between
// offer and answer m= sections, which surfaced as a *different* crash
// a later ICE candidate for the (now-missing) video mid: "Media section
// for sdpMid was not found". The test below guards against that
// regression too, by adding a candidate for the video mid after answering.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RTCPeerConnection, RTCRtpCodecParameters, useVP8 } from "werift";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawOffer = readFileSync(join(__dirname, "fixtures/live-browser-offer-with-video.sdp"), "utf8");

const OPUS = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48000,
  channels: 2,
  payloadType: 111,
});

test("audio-only codec config reproduces the real crash against real werift", async () => {
  const pc = new RTCPeerConnection({ codecs: { audio: [OPUS] } });
  await assert.rejects(
    () => pc.setRemoteDescription({ type: "offer", sdp: rawOffer }),
    /negotiate codecs failed/,
    "this is the exact failure captured live from the fire-pit/Blue-table bug"
  );
  pc.close();
});

test("adding video: [useVP8()] lets the real connection succeed, and answer/ICE stay usable", async () => {
  const pc = new RTCPeerConnection({ codecs: { audio: [OPUS], video: [useVP8()] } });
  await pc.setRemoteDescription({ type: "offer", sdp: rawOffer });

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // The answer must keep the same 3 m= sections (video, audio, application)
  // in the same order as the offer -- dropping the video section entirely
  // (the earlier, wrong fix) breaks this positional correspondence.
  const mLines = answer.sdp.split(/\r\n|\n/).filter((l) => l.startsWith("m="));
  assert.equal(mLines.length, 3, "answer must mirror the offer's 3 m= sections");
  assert.ok(mLines[0].startsWith("m=video"), "video section still present, at its original position");

  // A trickled ICE candidate for the video mid ("0" in this captured offer)
  // must still resolve to a real media section -- this is exactly what
  // broke when the video section was stripped from the SDP instead.
  await assert.doesNotReject(() =>
    pc.addIceCandidate({
      candidate: "candidate:1 1 UDP 2122260223 10.0.0.1 54321 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    })
  );

  pc.close();
});
