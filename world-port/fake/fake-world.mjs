// Offline WorldPort. Each behaviour is tagged with the scenario that needs it.
import { EventEmitter } from "node:events";

export class FakeWorld extends EventEmitter {
    // Meeting-area timing, from docs/field-notes.md "Map areas: dwell debounce":
  // "join only after **1.5 s continuously inside** (a real dwell, not a walk-through),
  // and linger **2.5 s** after leaving before tearing down." Tests pass short values.
  constructor({ server, name, versionHash = "23c8eb8c", facts = {}, dwellMs = 1500, lingerMs = 2500 }) {
    super();
    this.server = server;
    this.name = name;
    this.versionHash = versionHash;
    this.facts = facts;
    this.userId = null;
    this.pos = { x: 0, y: 0 };
    this.closed = false;
    this.dwellMs = dwellMs;
    this.lingerMs = lingerMs;
    this.inside = new Map(); // meeting area name -> { dwell, linger, joined }
  }

  // scenario: connecting:Our version is accepted
  // scenario: connecting:A stale version is turned away
  // scenario: connecting:A version turned away after joining
  async connect() {
    if (!this.server.accepts(this.versionHash)) {
      const err = this.server.newVersionError();
      if (!this.server.rejectAfterJoin) throw err;
      // Rejection arriving after join, not from connect().
      // The rejected avatar must not stay registered: leave before telling it.
      this.userId = this.server.join(this);
      queueMicrotask(() => {
        this.server.leave(this.userId);
        this.userId = null; // never announced: close() must not broadcast playerLeft
        this.emit("rejected", err);
      });
      return;
    }
    this.userId = this.server.join(this);
    // scenario: spawn:I appear in the world's start area
    const area = this.startArea();
    if (area) this.pos = { x: area.x + area.w / 2, y: area.y + area.h / 2 };
    const me = this.self();
    queueMicrotask(() => this.emit("joined", me));
    // scenario: presence:A player's arrival, movement and departure are seen
    this.server.broadcast(this.userId, "playerJoined", me);
    // scenario: presence:Walking next to another avatar puts both in the same meeting
    this.server.updateProximity();
  }

  // scenario: connecting:Our version is accepted
  // scenario: connecting:A stale version is turned away
  // scenario: connecting:A version turned away after joining
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const st of this.inside.values()) { clearTimeout(st.dwell); clearTimeout(st.linger); }
    this.inside.clear();
    if (this.userId != null) {
      this.server.leave(this.userId);
      // scenario: presence:A player's arrival, movement and departure are seen
      this.server.broadcast(this.userId, "playerLeft", { userId: this.userId, name: this.name });
    }
  }

  /** Simulate the server dropping us (not via close()). */
  // scenario: social:Bubbles can be set and cleared without losing the connection
  drop(code = 1006, reason = "") { this.emit("disconnected", { code, reason }); }

  // scenario: connecting:Our version is accepted
  self() {
    return { userId: this.userId, name: this.name, ...this.pos };
  }

  /** The start rectangle from the facts file, or null if the facts have none. */
  // scenario: spawn:I appear in the world's start area
  startArea() {
    const a = this.facts?.startArea;
    return a ? { x: a.x, y: a.y, w: a.w, h: a.h } : null;
  }

  /** Answers only from the facts file's landmarks; any other point is an error, never a guess. */
  // scenario: walls:The world says what is solid
  isSolid(x, y) {
    const l = (this.facts?.landmarks ?? []).find((m) => m.x === x && m.y === y);
    if (!l) throw new Error(`fake has no fact for (${x},${y})`);
    return l.solid;
  }

  // scenario: presence:A player's arrival, movement and departure are seen
  players() {
    return [...this.server.worlds.values()].filter((w) => w !== this).map((w) => w.self());
  }

  // scenario: presence:A player's arrival, movement and departure are seen
  // scenario: presence:Walking next to another avatar puts both in the same meeting
  // scenario: meetings:Walking into a meeting area joins its meeting
  async moveTo(x, y) {
    this.pos = { x, y };
    this.server.broadcast(this.userId, "playerMoved", this.self());
    this.server.updateProximity();
    this._updateAreas();
  }

  // scenario: social:A chat message in a shared meeting reaches the other avatar
  chat(spaceName, text) {
    this.server.relayToSpace(this.userId, spaceName, "chatMessage",
      { spaceName, senderUserId: this.userId, name: this.name, text });
  }

  // Bubbles are only state on the avatar: the fake relays nothing and stays connected.
  // scenario: social:Bubbles can be set and cleared without losing the connection
  speechBubble(text) { this.bubble = { type: "speech", text }; }
  // scenario: social:Bubbles can be set and cleared without losing the connection
  thoughtBubble(text) { this.bubble = { type: "thought", text }; }
  // scenario: social:Bubbles can be set and cleared without losing the connection
  clearBubble() { this.bubble = null; }

  // scenario: social:An emote reaches the other avatar
  emote(emoji) {
    this.server.broadcast(this.userId, "emote", { userId: this.userId, name: this.name, emote: emoji });
  }

  // scenario: invites:An invitation is received, accepted and brings both avatars together
  invite(playerName) { this.server.invite(this.userId, playerName); }

  /** Accepting walks us next to the inviter (as the real client does), which puts us in their meeting. */
  // scenario: invites:An invitation is received, accepted and brings both avatars together
  async acceptInvite(fromName) {
    const fromId = this.server.idByName(fromName);
    this.server.answerInvite(this.userId, fromName, true);
    const t = this.server.worlds.get(fromId).self();
    await this.moveTo(t.x - 32, t.y);
  }

  // scenario: mic:A peer's microphone state is seen by the other avatar in the meeting
  setMic(on) {
    for (const spaceName of this.server.spacesOf(this.userId)) {
      this.server.relayToSpace(this.userId, spaceName, "peerMic", { name: this.name, on: !!on });
    }
  }

  /** The meeting areas listed in the facts file (the fake reads no maps). */
  meetingAreas() {
    return this.facts?.meetingAreas ?? [];
  }

  // scenario: meetings:Walking into a meeting area joins its meeting
  _updateAreas() {
    const { x, y } = this.pos;
    for (const a of this.meetingAreas()) {
      const here = x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h;
      const st = this.inside.get(a.name);
      const spaceName = a.space ?? a.name;
      if (here && !st) {
        const s = { dwell: null, linger: null, joined: false };
        this.inside.set(a.name, s);
        this.emit("areaEntered", { name: a.name });
        s.dwell = setTimeout(() => {
          s.joined = true;
          this.emit("meetingJoined", { spaceName });
        }, this.dwellMs);
        s.dwell.unref?.();
      } else if (here && st) {
        clearTimeout(st.linger); // came back inside during the linger: stay in the meeting
        st.linger = null;
      } else if (!here && st && !st.linger) {
        this.emit("areaLeft", { name: a.name });
        clearTimeout(st.dwell);
        if (!st.joined) { this.inside.delete(a.name); continue; }
        st.linger = setTimeout(() => {
          this.inside.delete(a.name);
          this.emit("meetingLeft", { spaceName });
        }, this.lingerMs);
        st.linger.unref?.();
      }
    }
  }
}
