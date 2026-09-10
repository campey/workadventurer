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
import { ensureOpus } from "./transcode.mjs";

const OPUS = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48000,
  channels: 2,
  payloadType: 111,
});

const rnd32 = () => Math.floor(Math.random() * 0xffffffff) >>> 0;

export class WaAudio extends EventEmitter {
  /** @param {import("./wa-client.mjs").WorkAdventureClient} client */
  constructor(client, { iceServers } = {}) {
    super();
    this.client = client;
    this.iceServers = iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }];
    /** @type {Map<string,{pc:RTCPeerConnection,track:MediaStreamTrack,spaceName:string,remoteUserId:string}>} */
    this.peers = new Map();
    this._play = null; // { stop(): void } while a clip is playing

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
    pc.addTransceiver(track, { direction: "sendonly" });
    // simple-peer always negotiates a data channel and only fires its `connect`
    // event once that channel opens — so we must answer the `m=application`
    // section. Creating our own channel makes werift include SCTP in the answer.
    pc.createDataChannel("simplepeer", { negotiated: false });
    pc.onDataChannel.subscribe((ch) =>
      this.emit("log", `[${connectionId}] datachannel "${ch.label}"`)
    );

    pc.connectionStateChange.subscribe((s) => {
      this.emit("log", `[${connectionId}] pc ${s}`);
      if (s === "failed" || s === "closed") this._closePeer(connectionId, s);
      if (s === "connected") {
        // Re-assert mic-on now that this peer is up, so it doesn't have us
        // cached as muted and drop our audio track (#10).
        this.client.setSpaceMicState(spaceName, true);
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
        await p.pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        await this._iceComplete(p.pc);
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
  async play(file) {
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
    this._setSpeaking(true);

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
    this._setSpeaking(false);
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

  _setSpeaking(on) {
    // Show the "speaking" indicator, and (re)assert mic-on while we do — the
    // one-shot mic-state announce at join sometimes doesn't stick on the other
    // clients' UI, leaving a phantom muted icon. See #10.
    for (const spaceName of this.client.spaces.keys()) {
      const mine = this.client.spaces.get(spaceName);
      if (!mine) continue;
      try {
        this.client._send({
          updateSpaceUserMessage: {
            spaceName,
            user: {
              spaceUserId: mine.spaceUserId,
              showVoiceIndicator: !!on,
              microphoneState: true,
            },
            updateMask: { paths: this.client.adapter.micState.speakingMaskPaths },
          },
        });
      } catch {}
    }
  }
}
