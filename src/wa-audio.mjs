// Publishes audio into WorkAdventure proximity meetings over P2P WebRTC.
//
// WorkAdventure's front-end uses @workadventure/simple-peer. When someone new
// enters a bubble, the *existing* members get `webRtcStartMessage` with
// `initiator:true` and send a full (non-trickle) SDP offer; the joiner gets
// `initiator:false` and answers. Our headless client is always the joiner, so
// this module only ever *answers* — no offer/negotiation logic needed.
//
// Signals ride `PrivateSpaceEvent.webRtcSignal.signal` as a JSON string in
// simple-peer's `SignalData` shape: {type:"offer"|"answer", sdp} or
// {type:"candidate", candidate:{…}} or {type:"renegotiate", …}.
//
// One RTCPeerConnection per `connectionId` (a 3-person bubble is a mesh). Each
// gets one sendonly Opus track fed from a pre-encoded Ogg/Opus clip.

import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RTCRtpCodecParameters,
  RtpPacket,
  RtpHeader,
} from "werift";
import { readOggOpus } from "./ogg-opus.mjs";
import { ensureOpus, silenceOpusFile } from "./transcode.mjs";
import { SttStream } from "./wa-stt.mjs";
import { writeFileSync } from "node:fs"; // TEMP: SDP_DEBUG diagnostic only

const OPUS = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48000,
  channels: 2,
  payloadType: 111,
});

const rnd32 = () => Math.floor(Math.random() * 0xffffffff) >>> 0;
const MAX_STT_STREAMS = 2; // hard cap: each is a real ffmpeg process + worker socket

// TEMP diagnostic (werift<->werift media investigation): SDP_DEBUG=<dir> dumps
// every offer/answer to <dir>/<connectionId>-<label>.sdp.
function dumpSdp(connectionId, label, sdp) {
  const dir = process.env.SDP_DEBUG;
  if (!dir) return;
  try {
    writeFileSync(`${dir}/${connectionId.slice(0, 8)}-${label}.sdp`, sdp);
  } catch {}
}

// Sample count of a raw Opus packet, from its TOC byte (RFC 6716 Table 2) —
// same math as ogg-opus.mjs, needed here for inbound (listen-mode) packets.
function opusSamples(pkt) {
  const toc = pkt[0];
  const config = toc >> 3;
  const frameMs = config < 12 ? [10, 20, 40, 60][config & 3] : config < 16 ? [10, 20][config & 1] : [2.5, 5, 10, 20][config & 3];
  const code = pkt[0] & 3;
  const count = code === 0 ? 1 : code === 1 || code === 2 ? 2 : pkt.length > 1 ? pkt[1] & 0x3f : 1;
  return Math.round(48 * frameMs * count);
}

export class WaAudio extends EventEmitter {
  /** @param {import("./wa-client.mjs").WorkAdventureClient} client */
  constructor(client, { iceServers, listen = false } = {}) {
    super();
    this.client = client;
    this.iceServers = iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }];
    // Live speech-to-text on peers' inbound audio (issue #23). A pure listener
    // doesn't need to look mic-on, so it skips the connect-time prime too.
    this.listen = listen;
    /** @type {Map<string,{pc:RTCPeerConnection,track:MediaStreamTrack,spaceName:string,remoteUserId:string}>} */
    this.peers = new Map();
    this._play = null; // { stop(): void } while a clip is playing
    this._silencePath = null; // cached short silence clip for the connect-time prime

    client.on("spaceJoined", () => this._loadIce());
    client.on("spaceEvent", (e) => this._onSpaceEvent(e));
    client.on("bubbleLeft", () => this.hangup("left bubble"));
    client.on("close", () => this.hangup("client closed"));
  }

  get connected() {
    return [...this.peers.values()].some(
      (p) => p.pc.connectionState === "connected"
    );
  }

  async _loadIce() {
    try {
      const ans = await this.client.query("iceServersQuery", {});
      const list = ans.iceServersAnswer?.iceServers ?? [];
      if (list.length) {
        this.iceServers = list.map((s) => ({
          urls: s.urls,
          username: s.username || undefined,
          credential: s.credential || undefined,
        }));
        this.emit("log", `ICE: ${this.iceServers.map((s) => s.urls).join(", ")}`);
      }
    } catch (e) {
      this.emit("log", `iceServersQuery failed (${e.message}); using default STUN`);
    }
  }

  _onSpaceEvent({ spaceName, senderUserId, kind, payload }) {
    switch (kind) {
      case "webRtcStartMessage": {
        const initiator = !!payload.initiator;
        this.emit(
          "log",
          `webRtcStart conn=${payload.connectionId} from=${senderUserId} initiator=${initiator}`
        );
        const p = this._peer(spaceName, senderUserId, payload.connectionId);
        // The server assigns the role per connection: initiator sends the offer,
        // the other side waits for it. (It varies — don't assume either.)
        if (initiator) this._makeOffer(p).catch((e) => this.emit("log", `offer failed: ${e.message}`));
        break;
      }
      case "webRtcSignal":
        this._onSignal(spaceName, senderUserId, payload.connectionId, payload.signal);
        break;
      case "webRtcDisconnectMessage":
        this._closePeer(this._connIdForUser(senderUserId), "peer disconnect");
        break;
      case "switchMessage":
      case "finalizeSwitchMessage":
        if (payload.strategy && payload.strategy.toUpperCase() !== this.client.adapter.meeting.webrtcStrategyName) {
          this.emit("log", `meeting strategy → ${payload.strategy}; P2P audio idle`);
          this.hangup(`switched to ${payload.strategy}`);
        }
        break;
    }
  }

  _connIdForUser(userId) {
    for (const [id, p] of this.peers) if (p.remoteUserId === userId) return id;
    return null;
  }

  _peer(spaceName, remoteUserId, connectionId) {
    let p = this.peers.get(connectionId);
    if (p) return p;

    // A fresh connectionId for a user we already have supersedes the old one
    // (the front does this when a stalled connection is retried).
    for (const [id, old] of this.peers) {
      if (old.remoteUserId === remoteUserId) this._closePeer(id, "superseded");
    }

    const pc = new RTCPeerConnection({
      codecs: { audio: [OPUS] },
      iceServers: this.iceServers,
      bundlePolicy: "max-bundle",
    });
    const track = new MediaStreamTrack({ kind: "audio" });
    // `sendrecv` when listening — the browser only sends us its mic if we
    // negotiate a receive direction too; plain `sendonly` tells it not to.
    pc.addTransceiver(track, { direction: this.listen ? "sendrecv" : "sendonly" });
    // simple-peer always negotiates a data channel and only fires its `connect`
    // event once that channel opens — so we must answer the `m=application`
    // section. Creating our own channel makes werift include SCTP in the answer.
    pc.createDataChannel("simplepeer", { negotiated: false });
    pc.onDataChannel.subscribe((ch) =>
      this.emit("log", `[${connectionId}] datachannel "${ch.label}"`)
    );

    if (this.listen) {
      // Live speech-to-text on this peer's inbound audio (issue #23). Guarded
      // against werift's peer-connect churn (#29): at most one SttStream per
      // connection (onTrack can in principle fire more than once), and a hard
      // cap on how many run at once — each one is a real ffmpeg process plus a
      // socket into the shared worker, and repeated/rapid connects piling
      // those up unbounded is exactly what spiked the daemon.
      pc.onTrack.subscribe((remoteTrack) => {
        if (remoteTrack.kind !== "audio") return;
        const mine = this.peers.get(connectionId);
        if (!mine || mine.stt) return; // already listening on this connection
        const active = [...this.peers.values()].filter((p) => p.stt).length;
        if (active >= MAX_STT_STREAMS) {
          this.emit("log", `[${connectionId}] stt skipped — ${MAX_STT_STREAMS} already active`);
          return;
        }
        const stt = new SttStream();
        stt.on("log", (m) => this.emit("log", `[${connectionId}] stt: ${m}`));
        stt.on("error", (e) => this.emit("log", `[${connectionId}] stt error: ${e.message}`));
        stt.on("partial", (m) => this.emit("heard", { connectionId, remoteUserId, ...m, final: false }));
        stt.on("final", (m) => this.emit("heard", { connectionId, remoteUserId, ...m, final: true }));
        remoteTrack.onReceiveRtp.subscribe((rtp) =>
          stt.push({ data: rtp.payload, samples: opusSamples(rtp.payload) })
        );
        mine.stt = stt;
      });
    }

    pc.connectionStateChange.subscribe((s) => {
      this.emit("log", `[${connectionId}] pc ${s}`);
      if (s === "failed" || s === "closed") this._closePeer(connectionId, s);
      if (s === "connected") {
        if (this.listen) {
          // A pure listener doesn't send anything — say so honestly, no prime.
          this.client.setSpaceMicState(spaceName, false);
        } else {
          // Re-assert mic-on now that this peer is up, so it doesn't have us
          // cached as muted and drop our audio track (#10).
          this.client.setSpaceMicState(spaceName, true);
          // …and send a brief silence blip so the peer sees a live stream and
          // clears the "mic on, receiving nothing" red indicator (#10).
          this._primeMic();
        }
        this.emit("peerConnected", { connectionId, remoteUserId });
      }
    });
    pc.iceConnectionStateChange.subscribe((s) =>
      this.emit("log", `[${connectionId}] ice ${s}`)
    );

    // One stable RTP identity per peer for the whole connection — like a real
    // mic. Switching ssrc/seq between clips makes the receiver drop the later
    // ones (it has already latched onto the first source).
    p = {
      pc, track, spaceName, remoteUserId, connectionId,
      ssrc: rnd32(),
      seq: Math.floor(Math.random() * 0xffff),
      ts: rnd32() >>> 1,
      lastPlayEnd: performance.now(),
    };
    this.peers.set(connectionId, p);
    return p;
  }

  // We're the initiator for this connection: create and send the SDP offer.
  async _makeOffer(p) {
    await p.pc.setLocalDescription(await p.pc.createOffer());
    await this._iceComplete(p.pc);
    dumpSdp(p.connectionId, "offer-local", p.pc.localDescription.sdp);
    this.client.sendSpacePrivateEvent(p.spaceName, p.remoteUserId, {
      webRtcSignal: {
        connectionId: p.connectionId,
        signal: JSON.stringify({ type: "offer", sdp: p.pc.localDescription.sdp }),
      },
    });
    this.emit("log", `[${p.connectionId}] offered`);
  }

  async _onSignal(spaceName, remoteUserId, connectionId, signalJson) {
    let sig;
    try {
      sig = JSON.parse(signalJson);
    } catch {
      return this.emit("log", `[${connectionId}] unparseable signal`);
    }
    const p = this._peer(spaceName, remoteUserId, connectionId);

    try {
      if (sig.type === "offer") {
        dumpSdp(connectionId, "offer-remote", sig.sdp);
        await p.pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        await this._iceComplete(p.pc);
        dumpSdp(connectionId, "answer-local", p.pc.localDescription.sdp);
        this.client.sendSpacePrivateEvent(spaceName, remoteUserId, {
          webRtcSignal: {
            connectionId,
            signal: JSON.stringify({
              type: "answer",
              sdp: p.pc.localDescription.sdp,
            }),
          },
        });
        this.emit("log", `[${connectionId}] answered`);
      } else if (sig.type === "answer") {
        dumpSdp(connectionId, "answer-remote", sig.sdp);
        await p.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });
      } else if (sig.type === "candidate" && sig.candidate) {
        await p.pc.addIceCandidate(sig.candidate).catch(() => {});
      }
      // {type:"renegotiate"} / {transceiverRequest} — ignored; our track is static.
    } catch (e) {
      this.emit("log", `[${connectionId}] signal error: ${e.message}`);
    }
  }

  _iceComplete(pc, timeoutMs = 4000) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      const t = setTimeout(done, timeoutMs);
      pc.iceGatheringStateChange.subscribe((s) => {
        if (s === "complete") {
          clearTimeout(t);
          done();
        }
      });
    });
  }

  _closePeer(connectionId, why = "") {
    const p = connectionId && this.peers.get(connectionId);
    if (!p) return;
    this.peers.delete(connectionId);
    try {
      p.stt?.close();
    } catch {}
    try {
      p.pc.close();
    } catch {}
    this.emit("log", `[${connectionId}] closed${why ? ` (${why})` : ""}`);
  }

  hangup(why = "") {
    for (const id of [...this.peers.keys()]) this._closePeer(id, why);
    this._play?.stop();
  }

  /**
   * Play an audio clip into every connected peer. Any format ffmpeg can read is
   * accepted (transcoded to Opus on first use); Opus-in-Ogg plays as-is.
   * Resolves when the clip finishes or is superseded by another play()/hangup().
   */
  async play(file, { indicator = true } = {}) {
    const opus = await ensureOpus(file);
    const { packets, totalSamples } = await readOggOpus(opus);
    if (!packets.length) return { played: false, reason: "empty clip" };

    this._play?.stop();
    let stopped = false;
    this._play = { stop: () => (stopped = true) };

    const targets = [...this.peers.values()].filter(
      (p) => p.pc.connectionState === "connected"
    );
    if (!targets.length) {
      this._play = null;
      return { played: false, reason: "no connected peers" };
    }

    // Advance each peer's timestamp over the silent gap since its last clip so
    // the RTP clock stays wall-clock-continuous, and mark the first packet as a
    // new talkspurt (RFC 3551) so the receiver resyncs its jitter buffer.
    const now0 = performance.now();
    for (const p of targets) {
      const gapSamples = Math.round(((now0 - p.lastPlayEnd) / 1000) * 48000);
      p.ts = (p.ts + Math.max(0, gapSamples)) >>> 0;
    }
    this._setSpeaking(true, indicator);

    let sent = 0;
    let errs = 0;
    let firstOfTalkspurt = true;
    const startedAt = performance.now();
    let elapsedMs = 0;
    for (const { data, samples } of packets) {
      if (stopped) break;
      for (const p of targets) {
        const header = new RtpHeader({
          payloadType: OPUS.payloadType,
          sequenceNumber: p.seq++ & 0xffff,
          timestamp: p.ts >>> 0,
          ssrc: p.ssrc,
          marker: firstOfTalkspurt,
        });
        try {
          p.track.writeRtp(new RtpPacket(header, data));
          sent++;
        } catch (e) {
          errs++;
          if (errs === 1) this.emit("log", `writeRtp error: ${e.message}`);
        }
        p.ts = (p.ts + samples) >>> 0;
      }
      firstOfTalkspurt = false;
      elapsedMs += (samples / 48000) * 1000;
      const drift = startedAt + elapsedMs - performance.now();
      if (drift > 1) await sleep(drift);
    }

    const endAt = performance.now();
    for (const p of targets) p.lastPlayEnd = endAt;
    this._setSpeaking(false, indicator);
    this._play = null;
    const states = targets.map((p) => p.pc.connectionState);
    return {
      played: !stopped,
      seconds: +(totalSamples / 48000).toFixed(2),
      peers: targets.length,
      packetsSent: sent,
      writeErrors: errs,
      peerStates: states,
    };
  }

  _setSpeaking(on, indicator = true) {
    // Show the "speaking" indicator, and (re)assert mic-on while we do — the
    // one-shot mic-state announce at join sometimes doesn't stick on the other
    // clients' UI, leaving a phantom muted icon. See #10. `indicator: false`
    // (the connect-time prime) re-asserts mic-on without lighting the ring.
    for (const spaceName of this.client.spaces.keys()) {
      const mine = this.client.spaces.get(spaceName);
      if (!mine) continue;
      try {
        this.client._send({
          updateSpaceUserMessage: {
            spaceName,
            user: {
              spaceUserId: mine.spaceUserId,
              showVoiceIndicator: indicator ? !!on : false,
              microphoneState: true,
            },
            updateMask: { paths: this.client.adapter.micState.speakingMaskPaths },
          },
        });
      } catch {}
    }
  }

  // One short silence clip right after a peer connects. Some clients render our
  // mic red ("on, receiving nothing") until the first RTP lands; a ~0.4 s blip
  // primes the path and it stays fine until the next real clip. Bounded — no
  // continuous stream, so nothing to leak.
  async _primeMic() {
    if (this._play) return; // a real clip is already going — no need
    try {
      this._silencePath ??= await silenceOpusFile();
      if (this._play) return;
      const r = await this.play(this._silencePath, { indicator: false });
      this.emit(
        "log",
        `mic primed: ${r.packetsSent ?? 0} silence pkts to ${r.peers ?? 0} peer(s)` +
          (r.played ? "" : ` — ${r.reason ?? "?"}`)
      );
    } catch (e) {
      this.emit("log", `mic prime skipped: ${e.message}`);
    }
  }
}
