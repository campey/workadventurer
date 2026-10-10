// Live WorldPort: a real WorkAdventureClient against a real server. Mirrors the
// fake's event semantics (world-port/fake/fake-world.mjs).
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { WorkAdventureClient } from "../../src/wa-client.mjs";
import { isVersionRejection } from "../../src/server-rejected.mjs";
import { record, save } from "../recorder.mjs";

const info = (p) => ({ userId: p.userId, name: p.name ?? "", x: p.x, y: p.y });

export class LiveWorld extends EventEmitter {
  /** recordTo: array sink for recorded traffic; with RECORD=1 and no sink, saved on close(). */
  constructor({ roomUrl, name, versionHash = null, recordTo = null, fetch = globalThis.fetch, WebSocketImpl = WebSocket }) {
    super();
    this.name = name;
    this.closed = false;
    this._connecting = false;
    this._sink = recordTo ?? (process.env.RECORD === "1" ? [] : null);
    this._saveOnClose = recordTo == null && this._sink != null;
    const seam = this._sink
      ? record({ fetch, WebSocketImpl }, this._sink)
      : {};
    this.client = new WorkAdventureClient({
      roomUrl,
      name,
      ...(versionHash ? { version: versionHash } : {}),
      fetch: seam.fetch ?? fetch,
      WebSocketImpl: seam.WebSocketImpl ?? WebSocketImpl,
    });
    this._wire();
  }

  _wire() {
    const c = this.client;
    const fwd = (from, to, map = (x) => x) => c.on(from, (p) => this.emit(to, map(p)));
    c.on("joined", () => this.emit("joined", this.self()));
    c.on("error", (e) => {
      // During connect() a rejection rejects connect(), as in the fake.
      if (isVersionRejection(e)) { if (!this._connecting) this.emit("rejected", e); }
      else if (this.listenerCount("error")) this.emit("error", e);
    });
    // The client deletes a player before emitting playerLeft (src/wa-client.mjs), so remember names here.
    const names = new Map(); // userId -> name
    const pending = (this._pendingInvites = new Map()); // sender name -> uuid
    const remember = (p) => { if (p?.name) names.set(p.userId, p.name); };
    c.on("playerJoined", remember);
    c.on("playerMoved", remember);
    fwd("playerJoined", "playerJoined", info);
    fwd("playerMoved", "playerMoved", (p) => (p ? info(p) : p));
    fwd("playerLeft", "playerLeft", (userId) => {
      const name = names.get(userId) ?? c.players.get(userId)?.name ?? "";
      names.delete(userId);
      return { userId, name };
    });
    fwd("areaEnter", "areaEntered");
    fwd("areaLeave", "areaLeft");
    fwd("spaceJoined", "meetingJoined");
    fwd("spaceLeft", "meetingLeft");
    fwd("inviteReceived", "inviteReceived", (e) => {
      if (e.uuid) pending.set(e.name, e.uuid); // kept for acceptInvite(); never surfaced
      return { name: e.name };
    });
    fwd("inviteAnswered", "inviteAnswered");
    fwd("peerMic", "peerMic", (e) => ({ name: e.name, on: e.on }));
    fwd("chatMessage", "chatMessage");
    fwd("emote", "emote");
  }

  async connect() {
    this._connecting = true;
    try {
      await this.client.connect();
    } finally {
      this._connecting = false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this._onVoiceEvent) this.client.off?.("spaceEvent", this._onVoiceEvent);
      try { this.audio?.hangup?.("world closed"); } catch { /* best effort */ }
      this.client.close();
    } finally {
      if (this._saveOnClose) this.recordingPath = save(this._sink, this.name);
    }
  }

  self() {
    const c = this.client;
    return { userId: c.myUserId, name: this.name, x: Math.round(c.pos.x), y: Math.round(c.pos.y) };
  }

  /** The .wam start area, preferring isDefault (same rule as _wamSpawnPoint), or null. */
  startArea() {
    const isStart = (p) => p.type === "start";
    const starts = (this.client.areas ?? []).filter((a) => (a.rawProps ?? []).some(isStart));
    if (!starts.length) return null;
    const a = starts.find((s) => s.rawProps.some((p) => isStart(p) && p.isDefault)) ?? starts[0];
    return { x: a.x, y: a.y, w: a.w, h: a.h };
  }

  isSolid(x, y) {
    const nav = this.client.nav;
    if (!nav) throw new Error("no collision map for this room");
    return !!nav.isPxBlocked(x, y);
  }

  players() {
    return this.client.listPlayers().map(info);
  }

  // Position update, no pathfinding.
  async moveTo(x, y) {
    this.client.pos.x = x;
    this.client.pos.y = y;
    this.client._emitMove(false);
  }

  chat(spaceName, text) { this.client.sendChatMessage(spaceName, text); }
  speechBubble(text) { this.client.speechBubble(text); }
  thoughtBubble(text) { this.client.thoughtBubble(text); }
  clearBubble() { this.client.clearBubble(); }
  invite(playerName) {
    const p = this.client.listPlayers().find((q) => q.name === playerName);
    if (!p) throw new Error(`unknown player "${playerName}"`);
    if (!p.uuid) throw new Error(`no uuid known for player "${playerName}"`);
    this.client.sendMeetingInvitation(p.uuid, p.userId ?? null);
  }

  /** Accept, then walk to the sender (the server only seats us once we are near). */
  async acceptInvite(fromName) {
    const uuid = this._pendingInvites.get(fromName);
    if (!uuid) throw new Error(`no pending invite from "${fromName}"`);
    this._pendingInvites.delete(fromName);
    this.client.acceptMeetingInvitation(uuid);
    const sender = () => this.client.listPlayers().find((q) => q.name === fromName);
    if (!sender()) return;
    await this.client.walkTo(sender().x, sender().y, { getTarget: () => sender() ?? null });
  }

  setMic(on) {
    this.client.micOn = !!on;
    for (const spaceName of this.client.spaces.keys()) this.client.setSpaceMicState(spaceName, on);
  }

  emote(emoji) { this.client.sendEmote(emoji); }

  /**
   * Attach WaAudio the way src/wa-daemon.mjs does (no listen/STT) and emit `voiceSignal`
   * for the signalling the client sees: webRtcStartMessage -> webrtc, livekitInvitationMessage
   * -> livekit. Opt-in so ordinary scenarios never start audio. `makeAudio(client)` is a test seam.
   */
  async enableVoice({ makeAudio } = {}) {
    if (this.audio) return;
    if (!makeAudio) {
      const { WaAudio } = await import("../../src/wa-audio.mjs");
      makeAudio = (client) => new WaAudio(client, { listen: false });
    }
    this.audio = makeAudio(this.client);
    this._onVoiceEvent = ({ kind, senderUserId }) => {
      if (kind === "webRtcStartMessage") {
        this.emit("voiceSignal", { kind: "webrtc", with: this.client.spaceUserNames?.get(senderUserId) ?? null });
      } else if (kind === "livekitInvitationMessage") {
        this.emit("voiceSignal", { kind: "livekit", with: null });
      }
    };
    this.client.on("spaceEvent", this._onVoiceEvent);
  }
}
