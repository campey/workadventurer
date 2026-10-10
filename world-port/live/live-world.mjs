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
    fwd("inviteReceived", "inviteReceived");
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
}
