// Offline WorldPort. Each behaviour is tagged with the scenario that needs it.
import { EventEmitter } from "node:events";

export class FakeWorld extends EventEmitter {
  constructor({ server, name, versionHash = "23c8eb8c", facts = {} }) {
    super();
    this.server = server;
    this.name = name;
    this.versionHash = versionHash;
    this.facts = facts;
    this.userId = null;
    this.pos = { x: 0, y: 0 };
    this.closed = false;
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
    // scenario: none yet — WorldPort contract (playerJoined)
    this.server.broadcast(this.userId, "playerJoined", me);
  }

  // scenario: connecting:Our version is accepted
  // scenario: connecting:A stale version is turned away
  // scenario: connecting:A version turned away after joining
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.userId != null) {
      this.server.leave(this.userId);
      // scenario: none yet — WorldPort contract (playerLeft)
      this.server.broadcast(this.userId, "playerLeft", { userId: this.userId, name: this.name });
    }
  }

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

  // scenario: none yet — WorldPort contract
  players() {
    return [...this.server.worlds.values()].filter((w) => w !== this).map((w) => w.self());
  }

  // scenario: none yet — WorldPort contract
  async moveTo(x, y) {
    this.pos = { x, y };
    // scenario: none yet — WorldPort contract (playerMoved)
    this.server.broadcast(this.userId, "playerMoved", this.self());
  }
}
