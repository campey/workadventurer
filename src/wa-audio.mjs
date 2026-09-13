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
//
// Past WA's P2P-mesh size threshold, a meeting escalates to a LiveKit SFU
// instead (issue #8): the server sends `livekitInvitationMessage{token,
// serverUrl}` — the only connection material needed, no separate token
// minting — and later `livekitDisconnectMessage{}` when it de-escalates or
// we leave. That's a single connection to the room, not one per peer; `play()`
// routes to it automatically when active. Scoped to connect + publish for
// now — subscribing to others' LiveKit audio (e.g. for STT) is a follow-up.

import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RTCRtpCodecParameters,
  RtpPacket,
  RtpHeader,
} from "werift";
import {
  Room,
  AudioSource,
  LocalAudioTrack,
  AudioFrame,
  TrackPublishOptions,
  TrackSource,
  dispose as disposeLiveKitFfi,
} from "@livekit/rtc-node";
import { readOggOpus } from "./ogg-opus.mjs";
import { ensureOpus, ensurePcm, silenceOpusFile, invalidateCache } from "./transcode.mjs";
import { SttStream } from "./wa-stt.mjs";
import { writeFileSync } from "node:fs"; // TEMP: SDP_DEBUG diagnostic only

const LIVEKIT_SAMPLE_RATE = 48000;
const LIVEKIT_FRAME_MS = 20; // matches the WEBRTC path's Opus frame pacing

// Module-level (not per-instance): the LiveKit FFI runtime is shared process-
// wide, so its one-shot dispose() belongs at process-exit time, not tucked
// inside a single WaAudio's per-room teardown. Set on the first successful
// connect; disposeLiveKitRuntime() is a no-op if a room was never created —
// most daemon runs never escalate to LiveKit at all.
let livekitEverUsed = false;

/**
 * Release the shared LiveKit FFI runtime. Call exactly once, at process
 * shutdown (e.g. wa-daemon.mjs's SIGINT/SIGTERM handler) — never per-room-
 * disconnect, since a meeting can de-escalate and re-escalate LiveKit more
 * than once within one daemon's lifetime and there's only one runtime for
 * the whole process to share.
 */
export async function disposeLiveKitRuntime() {
  if (!livekitEverUsed) return;
  try {
    await disposeLiveKitFfi();
  } catch {}
}

const OPUS = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48000,
  channels: 2,
  payloadType: 111,
});

const rnd32 = () => Math.floor(Math.random() * 0xffffffff) >>> 0;
const MAX_STT_STREAMS = 2; // hard cap: each is a real ffmpeg process + worker socket

// TEMP diagnostic (werift<->werift media investigation): SDP_DEBUG=<dir> dumps
// every offer/answer to <dir>/<seq>-<connectionId>-<label>.sdp. The seq counter
// keeps renegotiations/retries on the same connection from overwriting each
// other's dumps (they'd otherwise share a filename).
let sdpDumpSeq = 0;
function dumpSdp(connectionId, label, sdp) {
  const dir = process.env.SDP_DEBUG;
  if (!dir) return;
  try {
    const n = String(++sdpDumpSeq).padStart(4, "0");
    writeFileSync(`${dir}/${n}-${connectionId.slice(0, 8)}-${label}.sdp`, sdp);
  } catch {}
}

// #32: an answer/offer with zero ICE candidates is guaranteed-dead — the
// peer has nothing to connect to. werift's ICE gathering always reports
// "complete" even when every candidate type failed, so this is the only way
// to actually detect it.
export function candidateCount(sdp) {
  return (sdp.match(/^a=candidate:/gm) || []).length;
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
    // connectionId -> Promise<peer>, for a peer that's under construction or
    // already built. Reserved synchronously (before the ICE-readiness await
    // below) so two near-simultaneous calls for the same connectionId await
    // the same construction instead of racing to build two PCs (#32).
    this._peerPromises = new Map();
    this._peerUsers = new Map(); // connectionId -> remoteUserId, for the supersede check above
    // connectionIds we've explicitly torn down — bounded, so a late signal
    // for one (after failed/closed/superseded) gets dropped instead of
    // resurrecting a dead connection (#32).
    this._closedConnIds = new Set();
    this._play = null; // { stop(): void } while a clip is playing
    this._silencePath = null; // cached short silence clip for the connect-time prime
    this._livekit = null; // { room, source, track } while a LiveKit-escalated meeting is active (#8)

    // Load ICE servers as early as possible, not gated on "spaceJoined" —
    // `_joinSpace` sends `addSpaceFilterMessage` well before that event
    // fires, and it's that message which makes the back start setting up
    // peer connections. A peer built before this resolves would otherwise
    // get werift's constructor-default STUN-only list permanently — werift
    // snapshots `iceServers` at construction and never re-reads it (#32).
    // `_loadIce()` never rejects (see below), so this is always safe to await.
    this._iceReady = this._loadIce();

    client.on("spaceEvent", (e) => this._onSpaceEvent(e));
    client.on("bubbleLeft", () => this.hangup("left bubble"));
    client.on("close", () => this.hangup("client closed"));
  }

  get connected() {
    // True on either transport (#8) — wa-daemon.mjs's /sound gate and /state
    // both read this, and neither should report "nobody to hear it" just
    // because a meeting escalated from WEBRTC peers to a LiveKit room.
    if (this._livekit) return true;
    return [...this.peers.values()].some(
      (p) => p.pc.connectionState === "connected"
    );
  }

  // Other participants on whichever transport is active — a WEBRTC bubble is
  // one peer connection per remote user; a LiveKit room is one connection
  // total, with everyone else as a remote participant on it (#8).
  get remoteCount() {
    if (this._livekit) return this._livekit.room.remoteParticipants.size;
    return this.peers.size;
  }

  // Never rejects — `_iceReady` (constructor) is awaited unconditionally by
  // every peer construction, so a hard failure here must still let peers
  // proceed (on the constructor-default STUN-only list) rather than wedge
  // forever. `client.query`'s own 10s timeout already bounds the wait.
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
        // The server assigns the role per connection: initiator sends the offer,
        // the other side waits for it. (It varies — don't assume either.)
        // _peer() now awaits ICE readiness (#32) before building the PC — not
        // awaited here since this handler runs synchronously off an event.
        this._peer(spaceName, senderUserId, payload.connectionId)
          .then((p) => (initiator ? this._makeOffer(p) : undefined))
          .catch((e) => this.emit("log", `[${payload.connectionId}] webRtcStart failed: ${e.message}`));
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
      case "livekitInvitationMessage":
        // The invitation is the actual trigger to connect — don't wait on
        // switchMessage/finalizeSwitchMessage, which are informational
        // strategy announcements and aren't guaranteed to arrive in any
        // particular order relative to this (#8).
        this._connectLiveKit(payload).catch((e) =>
          this.emit("log", `LiveKit connect failed: ${e.message}`)
        );
        break;
      case "livekitDisconnectMessage":
        this._disconnectLiveKit().catch((e) =>
          this.emit("log", `LiveKit disconnect error: ${e.message}`)
        );
        break;
    }
  }

  // Connect to the LiveKit SFU a meeting escalated to (#8) and publish one
  // audio track into it. A fresh invitation (re-escalation, restart) tears
  // down any prior connection first — same "fresh supersedes stale" pattern
  // used for WEBRTC peers.
  async _connectLiveKit({ token, serverUrl }) {
    await this._disconnectLiveKit();

    const room = new Room();
    await room.connect(serverUrl, token, {
      autoSubscribe: false, // subscribe (e.g. for STT) is an explicit follow-up, not this pass
      dynacast: false,
    });

    const source = new AudioSource(LIVEKIT_SAMPLE_RATE, 1);
    const track = LocalAudioTrack.createAudioTrack("wa-agent", source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant.publishTrack(track, opts);

    this._livekit = { room, source, track };
    livekitEverUsed = true;
    this.emit("log", `LiveKit connected (${room.remoteParticipants.size} other participant(s)) and publishing`);
  }

  async _disconnectLiveKit() {
    if (!this._livekit) return;
    const { room, track } = this._livekit;
    this._livekit = null;
    try {
      await track.close();
    } catch {}
    try {
      await room.disconnect();
    } catch {}
    this.emit("log", "LiveKit disconnected");
    // Not calling the module-level dispose() here: it releases the shared FFI
    // runtime for the whole process, not just this room — per LiveKit's own
    // docs it's a one-shot call at process exit, not per-disconnect (a
    // meeting can de-escalate and re-escalate LiveKit repeatedly within one
    // daemon's lifetime). The daemon's own shutdown path is responsible for
    // calling it once, if a LiveKit room was ever created.
  }

  _connIdForUser(userId) {
    // Check in-flight (still awaiting ICE) connections too, not just built
    // ones — a disconnect can arrive in that window (#32's async gap).
    for (const [id, otherUserId] of this._peerUsers) if (otherUserId === userId) return id;
    return null;
  }

  // Returns a Promise<peer> — get-or-create, reserving the connectionId's
  // slot synchronously (before _buildPeer's ICE-readiness await) so two
  // near-simultaneous calls for the same id share one construction (#32).
  _peer(spaceName, remoteUserId, connectionId) {
    const existing = this._peerPromises.get(connectionId);
    if (existing) return existing;
    // Recorded synchronously, alongside the promise reservation, so the
    // supersede check below can find an *in-flight* (still awaiting ICE)
    // connection for this user, not just an already-built one — a fresh
    // connectionId can otherwise arrive for the same user while the old
    // one is still mid-construction, and both would end up alive (#32).
    this._peerUsers.set(connectionId, remoteUserId);
    const promise = this._buildPeer(spaceName, remoteUserId, connectionId);
    this._peerPromises.set(connectionId, promise);
    return promise;
  }

  async _buildPeer(spaceName, remoteUserId, connectionId) {
    // A fresh connectionId for a user we already have supersedes the old one
    // (the front does this when a stalled connection is retried) — whether
    // that old one finished building or is still awaiting ICE.
    for (const [id, otherUserId] of this._peerUsers) {
      if (id !== connectionId && otherUserId === remoteUserId) this._closePeer(id, "superseded");
    }

    // Wait for the real ICE server list (#32) — see the constructor comment.
    // Bounded by client.query()'s own 10s timeout; _loadIce() never rejects.
    await this._iceReady;

    if (this._closedConnIds.has(connectionId)) {
      // Torn down (e.g. superseded) while we were waiting on ICE — don't
      // build a connection nobody wants any more.
      this._peerPromises.delete(connectionId);
      throw new Error("closed while waiting for ICE servers");
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
        // client.micOn — not `this.listen` — decides whether we publish.
        // Listening (STT) and publishing are independent; a future persona
        // that both listens and talks must not need special-casing here (#10).
        if (this.client.micOn) {
          // Re-assert mic-on now that this peer is up, so it doesn't have us
          // cached as muted and drop our audio track (#10).
          this.client.setSpaceMicState(spaceName, true);
          // …and send a brief silence blip so the peer sees a live stream and
          // clears the "mic on, receiving nothing" red indicator (#10).
          this._primeMic();
        } else {
          // We don't send anything — say so honestly, no prime.
          this.client.setSpaceMicState(spaceName, false);
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
    const p = {
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
    const sdp = p.pc.localDescription.sdp;
    dumpSdp(p.connectionId, "offer-local", sdp);
    const candidates = candidateCount(sdp);
    if (candidates === 0) {
      // Guaranteed-dead — see candidateCount() above (#32). Tear down rather
      // than ship an offer the peer can never connect to; a fresh
      // connectionId (WA's own retry) gets another chance.
      this.emit("log", `[${p.connectionId}] offer has zero ICE candidates — tearing down`);
      this._closePeer(p.connectionId, "no ice candidates");
      return;
    }
    this.client.sendSpacePrivateEvent(p.spaceName, p.remoteUserId, {
      webRtcSignal: {
        connectionId: p.connectionId,
        signal: JSON.stringify({ type: "offer", sdp }),
      },
    });
    this.emit("log", `[${p.connectionId}] offered (${candidates} ICE candidates)`);
  }

  async _onSignal(spaceName, remoteUserId, connectionId, signalJson) {
    if (this._closedConnIds.has(connectionId)) {
      // A signal for a connection we already tore down (failed/closed/
      // superseded) — drop it rather than resurrecting a dead PC (#32).
      this.emit("log", `[${connectionId}] signal for a closed connection, ignored`);
      return;
    }
    let sig;
    try {
      sig = JSON.parse(signalJson);
    } catch {
      return this.emit("log", `[${connectionId}] unparseable signal`);
    }
    let p;
    try {
      p = await this._peer(spaceName, remoteUserId, connectionId);
    } catch (e) {
      this.emit("log", `[${connectionId}] signal dropped: ${e.message}`);
      return;
    }

    try {
      if (sig.type === "offer") {
        dumpSdp(connectionId, "offer-remote", sig.sdp);
        await p.pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        await this._iceComplete(p.pc);
        const sdp = p.pc.localDescription.sdp;
        dumpSdp(connectionId, "answer-local", sdp);
        const candidates = candidateCount(sdp);
        if (candidates === 0) {
          this.emit("log", `[${connectionId}] answer has zero ICE candidates — tearing down`);
          this._closePeer(connectionId, "no ice candidates");
          return;
        }
        this.client.sendSpacePrivateEvent(spaceName, remoteUserId, {
          webRtcSignal: {
            connectionId,
            signal: JSON.stringify({ type: "answer", sdp }),
          },
        });
        this.emit("log", `[${connectionId}] answered (${candidates} ICE candidates)`);
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
    if (!connectionId) return;
    const hadPromise = this._peerPromises.delete(connectionId);
    this._peerUsers.delete(connectionId);
    // Mark closed unconditionally — including a peer that was still awaiting
    // ICE and never finished building — so a late signal for this id gets
    // dropped instead of resurrecting it (#32; see _onSignal/_buildPeer).
    this._closedConnIds.add(connectionId);
    if (this._closedConnIds.size > 64) {
      this._closedConnIds.delete(this._closedConnIds.values().next().value);
    }
    const p = this.peers.get(connectionId);
    if (!p) {
      if (hadPromise) this.emit("log", `[${connectionId}] closed before it finished connecting${why ? ` (${why})` : ""}`);
      return;
    }
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
    for (const id of new Set([...this.peers.keys(), ...this._peerPromises.keys()])) this._closePeer(id, why);
    this._play?.stop();
    this._disconnectLiveKit().catch((e) => this.emit("log", `LiveKit disconnect error: ${e.message}`));
  }

  /**
   * Play an audio clip into the active transport — every connected WEBRTC
   * peer, or the LiveKit room if a meeting has escalated to one (#8; at most
   * one is ever active for a given bubble). Any format ffmpeg can read is
   * accepted. Resolves when the clip finishes or is superseded by another
   * play()/hangup().
   */
  play(file, opts = {}) {
    return this._livekit ? this._playLiveKit(file, opts) : this._playWebrtc(file, opts);
  }

  async _playWebrtc(file, { indicator = true } = {}) {
    // Claim `_play` synchronously, before any awaits, so a second concurrent
    // call (e.g. a real clip landing mid-prime, or two peers connecting a few
    // ms apart) sees "something is already starting" immediately instead of
    // racing past this guard during the ensureOpus/readOggOpus awaits (#10).
    this._play?.stop();
    let stopped = false;
    const token = (this._play = { stop: () => (stopped = true) });

    const opus = await ensureOpus(file);
    const { packets, totalSamples } = await readOggOpus(opus);
    if (stopped) return { played: false, reason: "superseded" };
    if (!packets.length) {
      if (this._play === token) this._play = null;
      // A corrupt/truncated cache entry demuxes to zero packets — invalidate
      // it so the next call re-encodes instead of re-hitting the same broken
      // file forever (#10; no-ops for a caller-supplied path, see transcode.mjs).
      await invalidateCache(opus);
      return { played: false, reason: "empty clip" };
    }

    const targets = [...this.peers.values()].filter(
      (p) => p.pc.connectionState === "connected"
    );
    if (!targets.length) {
      if (this._play === token) this._play = null;
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
    if (this._play === token) this._play = null;
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

  // LiveKit publish path (#8). Mirrors _playWebrtc's shape (same `_play`
  // in-flight guard, same wall-clock pacing) but feeds raw PCM frames to
  // AudioSource.captureFrame() instead of Opus RTP packets — LiveKit's own
  // transport handles encoding.
  async _playLiveKit(file, { indicator = true } = {}) {
    this._play?.stop();
    let stopped = false;
    const token = (this._play = { stop: () => (stopped = true) });

    const { room, source } = this._livekit;
    const pcmPath = await ensurePcm(file, { sampleRate: LIVEKIT_SAMPLE_RATE, channels: 1 });
    const raw = await readFile(pcmPath);
    if (stopped) return { played: false, reason: "superseded" };
    if (raw.length < 2) {
      if (this._play === token) this._play = null;
      await invalidateCache(pcmPath);
      return { played: false, reason: "empty clip" };
    }

    // `raw` is a Buffer view into Node's shared, possibly-odd-offset pool —
    // reinterpreting its .buffer directly as Int16Array can throw ("start
    // offset ... must be a multiple of 2") or read garbage. Copy into a
    // fresh, zero-offset Uint8Array first (LiveKit's own docs warn about the
    // analogous .slice()-vs-.subarray() footgun for the same reason).
    const samples = new Int16Array(new Uint8Array(raw).buffer);

    const targets = room.remoteParticipants.size;
    this._setSpeaking(true, indicator);

    const frameSamples = (LIVEKIT_SAMPLE_RATE * LIVEKIT_FRAME_MS) / 1000;
    let sent = 0;
    let errs = 0;
    const startedAt = performance.now();
    let elapsedMs = 0;
    for (let i = 0; i < samples.length; i += frameSamples) {
      if (stopped) break;
      const chunk = samples.subarray(i, Math.min(i + frameSamples, samples.length));
      try {
        await source.captureFrame(new AudioFrame(chunk, LIVEKIT_SAMPLE_RATE, 1, chunk.length));
        sent++;
      } catch (e) {
        errs++;
        if (errs === 1) this.emit("log", `LiveKit captureFrame error: ${e.message}`);
      }
      elapsedMs += (chunk.length / LIVEKIT_SAMPLE_RATE) * 1000;
      const drift = startedAt + elapsedMs - performance.now();
      if (drift > 1) await sleep(drift);
    }
    if (!stopped) {
      try {
        await source.waitForPlayout();
      } catch {}
    }

    this._setSpeaking(false, indicator);
    if (this._play === token) this._play = null;
    return {
      played: !stopped,
      seconds: +(samples.length / LIVEKIT_SAMPLE_RATE).toFixed(2),
      peers: targets,
      packetsSent: sent,
      writeErrors: errs,
      transport: "livekit",
    };
  }

  _setSpeaking(on, indicator = true) {
    // Show the "speaking" indicator, and (re)assert mic-on while we do — the
    // one-shot mic-state announce at join sometimes doesn't stick on the other
    // clients' UI, leaving a phantom muted icon. See #10. `indicator: false`
    // (the connect-time prime) re-asserts mic-on without lighting the ring.
    //
    // microphoneState always mirrors client.micOn — never hardcoded true.
    // Otherwise a listen-mode instance that ever plays a clip (a debug /sound,
    // say) would advertise itself as mic-on permanently, with no stream
    // between clips: a fresh, harder-to-spot form of #10.
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
              microphoneState: this.client.micOn,
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
  //
  // One retry on failure (missing ffmpeg, corrupt cache); if both attempts
  // fail we go back to an honest mic-off rather than leaving the mic
  // advertised on with nothing ever sent — the exact "claimed but silent"
  // shape of #10 that a silent no-op used to leave behind.
  async _primeMic() {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (this._play) return; // a real clip is already going/queued — no need
      try {
        this._silencePath ??= await silenceOpusFile();
        if (this._play) return;
        const r = await this.play(this._silencePath, { indicator: false });
        if (r.played) {
          this.emit(
            "log",
            `mic primed: ${r.packetsSent ?? 0} silence pkts to ${r.peers ?? 0} peer(s)`
          );
          return;
        }
        if (r.reason === "no connected peers" || r.reason === "superseded") {
          return; // nothing to prime right now / a real clip won the race — fine
        }
        // "empty clip" — play() already invalidated the bad cache entry above;
        // clear our cached path too so the retry re-encodes rather than
        // resolving to the same (now-deleted) file again.
        this._silencePath = null;
        this.emit("log", `mic prime attempt ${attempt} failed: ${r.reason ?? "?"}`);
      } catch (e) {
        this._silencePath = null;
        this.emit("log", `mic prime attempt ${attempt} error: ${e.message}`);
      }
      if (attempt === 1) await sleep(300);
    }
    for (const spaceName of this.client.spaces.keys()) {
      this.client.setSpaceMicState(spaceName, false);
    }
    this.emit("log", "mic prime failed twice — reporting mic off, not claiming silently");
  }
}
