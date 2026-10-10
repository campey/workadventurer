// Live WorldPort: a real WorkAdventureClient against a real server. Mirrors the
// fake's event semantics (world-port/fake/fake-world.mjs).
import { EventEmitter } from "node:events";
import { DefaultWebSocket } from "./proxied-ws.mjs";
import { WorkAdventureClient } from "../../src/wa-client.mjs";
import { isVersionRejection } from "../../src/server-rejected.mjs";
import { record, save } from "../recorder.mjs";

const info = (p) => ({ userId: p.userId, name: p.name ?? "", x: p.x, y: p.y });

export class LiveWorld extends EventEmitter {
  /** recordTo: array sink for recorded traffic; with RECORD=1 and no sink, saved on close(). */
  constructor({ roomUrl, name, versionHash = null, recordTo = null, fetch = globalThis.fetch, WebSocketImpl = DefaultWebSocket }) {
    super();
    this.name = name;
    this.closed = false;
    this._walks = new Set(); // AbortControllers of walks in flight; close() aborts them
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
    // Only a drop we did not ask for: close() sets this.closed before the socket closes.
    c.on("close", (e) => { if (!this.closed) this.emit("disconnected", { code: e?.code, reason: e?.reason }); });
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
      // Be a polite leaver: stop walking, and leave every space so the server and peers drop our
      // meeting tile (a ghost video tile stayed when the socket was just dropped). Bounded: sync
      // sends only; a socket already gone throws, which must not stop the close.
      for (const walk of this._walks) walk.abort();
      for (const spaceName of [...(this.client.spaces?.keys() ?? [])]) {
        try { Promise.resolve(this.client._leaveSpace(spaceName)).catch(() => {}); } catch { /* socket gone */ }
      }
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

  /**
   * The nearest open floor to (x,y) that is outside every meeting area (plus a margin, so an
   * avatar that stops a few px short is still outside). The adapter works it out from the
   * collision map and the room's areas; without a map it can only return the point.
   */
  openSpotNear(x, y) {
    const nav = this.client.nav;
    if (!nav) return { x, y };
    const PAD = 32;
    const meetings = (this.client.areas ?? []).filter((a) => (a.rawProps ?? []).some((p) => p.type === "livekitRoomProperty"));
    const inMeeting = (px, py) =>
      meetings.some((a) => px >= a.x - PAD && px <= a.x + a.w + PAD && py >= a.y - PAD && py <= a.y + a.h + PAD);
    let best = null;
    for (let ty = 0; ty < nav.h; ty++) {
      for (let tx = 0; tx < nav.w; tx++) {
        if (nav.isTileBlocked(tx, ty)) continue;
        const [cx, cy] = nav.tileCenterPx(tx, ty);
        const d = Math.hypot(cx - x, cy - y);
        if ((best && d >= best.d) || inMeeting(cx, cy)) continue;
        best = { x: cx, y: cy, d };
      }
    }
    if (!best) throw new Error(`no open spot near (${x},${y})`);
    return { x: best.x, y: best.y };
  }

  /** Open floor inside a rectangle: the free tile centre nearest its centre (the centre itself may be solid, like the Fire Pit's fire). */
  openSpotInside(x, y, w, h) {
    const cx = x + w / 2, cy = y + h / 2;
    const nav = this.client.nav;
    if (!nav) return { x: cx, y: cy };
    let best = null;
    for (let ty = Math.floor(y / nav.tile); ty <= Math.floor((y + h) / nav.tile); ty++) {
      for (let tx = Math.floor(x / nav.tile); tx <= Math.floor((x + w) / nav.tile); tx++) {
        if (nav.isTileBlocked(tx, ty)) continue;
        const [px, py] = nav.tileCenterPx(tx, ty);
        if (px < x || px > x + w || py < y || py > y + h) continue;
        const d = Math.hypot(px - cx, py - cy);
        if (!best || d < best.d) best = { x: px, y: py, d };
      }
    }
    if (!best) throw new Error(`no open spot inside (${x},${y},${w},${h})`);
    return { x: best.x, y: best.y };
  }

  players() {
    return this.client.listPlayers().map(info);
  }

  /**
   * Walk there with the client's pathfinding (people watching see a walk, not a glide through
   * walls). Resolves on arrival; rejects if the avatar stops short (unreachable or blocked
   * goal, 30 s timeout) or the world is closed mid-walk. Only with no collision map: a position update.
   */
  async moveTo(x, y) {
    if (this.client.nav) {
      const walk = new AbortController();
      this._walks.add(walk);
      try {
        const r = await this.client.navTo(x, y, { stopWithin: 16, timeoutMs: 30000, signal: walk.signal });
        if (!r?.arrived) throw new Error(`${this.name} did not arrive at (${x},${y}): ${r?.reason ?? "unknown"}`);
      } finally {
        this._walks.delete(walk);
      }
      return;
    }
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
