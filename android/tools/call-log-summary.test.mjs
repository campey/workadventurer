import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, format } from "./call-log-summary.mjs";

const C = "5e884a5e-9dac-4ffd-b54a-409b25554e81";

// The 2026-10-07 staging call (issue #97): the browser joined muted, so the first offer had no audio line; the phone unmuted
// at :38 and told the server "mic on" with nothing to send on until the browser re-offered at :55.
const redMic = `# WorkAdventurer Android 0.1.0
# phone samsung SM-S938B, Android 16 (sdk 36)
# room https://play.staging.workadventu.re/@/tcm/workadventure/wa-village
# server staging
21:42:20.000 WaSession connecting
21:42:25.000 WaSession connected
21:42:34.421 WaConn joined space https://play.staging.workadventu.re/@/tcm/workadventure/wa-village#122#1
21:42:34.684 WaConn webRtcStart conn=${C} initiator=false
21:42:35.100 WaVoice [${C}] audio lines in offer: 0
21:42:35.111 WaVoice [${C}] answered
21:42:38.368 WaConn mic on: announcing to 1 space(s)
21:42:39.710 WaVoice [${C}] audio sent=0 recv=0 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir= mic=on
21:42:44.708 WaVoice [${C}] audio sent=0 recv=0 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir= mic=on
21:42:49.699 WaVoice [${C}] audio sent=0 recv=0 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir= mic=on
21:42:54.699 WaVoice [${C}] audio sent=0 recv=0 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir= mic=on
21:42:55.800 WaVoice [${C}] audio lines in offer: 1 (re-offer)
21:42:55.849 WaVoice [${C}] answered
21:42:59.704 WaVoice [${C}] audio sent=0 recv=95 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:43:04.696 WaVoice [${C}] audio sent=205 recv=95 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:43:09.697 WaVoice [${C}] audio sent=458 recv=330 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:43:37.271 WaSession mic muted (notification)
21:43:44.708 WaVoice [${C}] audio sent=1855 recv=598 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=off
21:43:49.708 WaVoice [${C}] audio sent=1855 recv=598 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=off
21:44:32.199 WaSession disconnected
`;

test("the header lines are kept", () => {
  const s = summarize(redMic);
  assert.equal(s.server, "staging");
  assert.match(s.room, /wa-village/);
  assert.match(s.phone, /SM-S938B/);
});

test("duration and time to connect come from the timestamps", () => {
  const s = summarize(redMic);
  assert.equal(s.connectMs, 5000);
  assert.equal(s.durationMs, 132199);
});

test("the muted-browser red mic is flagged: mic on, nothing sent, no audio line", () => {
  const s = summarize(redMic);
  assert.equal(s.redMicSuspects.length, 1);
  const r = s.redMicSuspects[0];
  assert.equal(r.fromAt, "21:42:38.368"); // when the phone announced mic on
  assert.equal(r.toAt, "21:43:04.696"); // first sample with packets sent
  assert.equal(r.noAudioLine, true);
});

test("a peer's first audio and the offers it saw are summarised", () => {
  const p = summarize(redMic).peers[0];
  assert.equal(p.initiator, false);
  assert.deepEqual(p.audioLinesInOffers, [0, 1]);
  assert.equal(p.reOffers, 1);
  assert.equal(p.firstRecvAt, "21:42:59.704");
  assert.equal(p.firstSentAt, "21:43:04.696");
  assert.equal(p.timeToFirstRecvMs, 25020);
});

test("a healthy call has no red-mic suspects", () => {
  const ok = `21:00:00.000 WaSession connecting
21:00:01.000 WaSession connected
21:00:02.000 WaConn webRtcStart conn=${C} initiator=true
21:00:02.100 WaVoice [${C}] offered
21:00:05.000 WaConn mic on: announcing to 1 space(s)
21:00:07.000 WaVoice [${C}] audio sent=100 recv=50 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:00:12.000 WaVoice [${C}] audio sent=350 recv=300 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:00:17.000 WaVoice [${C}] audio sent=600 recv=550 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:00:20.000 WaSession disconnected
`;
  const s = summarize(ok);
  assert.deepEqual(s.redMicSuspects, []);
  assert.equal(s.peers[0].initiator, true);
});

test("sending that stops while the mic is on is a stall; while muted it is not", () => {
  const stall = `21:00:00.000 WaSession connecting
21:00:00.500 WaSession connected
21:00:01.000 WaVoice [${C}] audio sent=100 recv=10 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:00:06.000 WaVoice [${C}] audio sent=350 recv=20 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:00:11.000 WaVoice [${C}] audio sent=350 recv=30 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:00:16.000 WaVoice [${C}] audio sent=350 recv=40 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:00:21.000 WaVoice [${C}] audio sent=600 recv=50 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=on
21:00:26.000 WaVoice [${C}] audio sent=600 recv=60 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=off
21:00:31.000 WaVoice [${C}] audio sent=600 recv=70 ice=CONNECTED conn=CONNECTED signaling=STABLE dtls=connected dir=SEND_RECV/SEND_RECV mic=off
`;
  const s = summarize(stall);
  assert.equal(s.peers[0].stalls.length, 1);
  assert.equal(s.peers[0].stalls[0].fromAt, "21:00:06.000");
  assert.equal(s.peers[0].stalls[0].toAt, "21:00:21.000");
});

test("drops, reconnects, errors, mutes and device events are listed", () => {
  const t = `21:00:00.000 WaSession connecting
21:00:01.000 WaSession connected
21:00:10.000 WaSession connection dropped: 1006 abnormal
21:00:10.100 WaSession reconnecting (attempt 1, in 1000 ms)
21:00:12.000 WaSession connected
21:00:20.000 WaSession mic unmuted (ui)
21:00:21.000 WaSession mic muted (notification)
21:00:22.000 WaSession mic unmuted (notification)
21:00:30.000 WaDevice audio device added: wired headset (output)
21:00:31.000 WaDevice screen off
21:00:32.000 WaDevice network: cellular validated (~12 Mbit/s down)
21:00:33.000 WaVoice ERROR closing links failed: boom
21:00:40.000 WaSession disconnected
`;
  const s = summarize(t);
  assert.equal(s.drops.length, 1);
  assert.match(s.drops[0].text, /1006 abnormal/);
  assert.equal(s.reconnects, 1);
  assert.deepEqual(s.mutes, { ui: 1, notification: 2 });
  assert.equal(s.deviceEvents.length, 3);
  assert.equal(s.errors.length, 1);
});

test("a call across midnight keeps its duration", () => {
  const s = summarize(`23:59:50.000 WaSession connecting\n00:00:10.000 WaSession disconnected\n`);
  assert.equal(s.durationMs, 20000);
});

test("the formatted report names the suspects and survives an empty file", () => {
  assert.match(format(summarize(redMic)), /RED MIC\?.*21:42:38\.368/s);
  assert.doesNotThrow(() => format(summarize("")));
});
