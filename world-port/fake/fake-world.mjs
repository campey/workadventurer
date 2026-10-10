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
  async connect() {
    if (!this.server.accepts(this.versionHash)) {
      const err = this.server.newVersionError();
      if (!this.server.rejectAfterJoin) throw err;
      // Rejection arriving after join, not from connect().
      this.userId = this.server.join(this);
      queueMicrotask(() => this.emit("rejected", err));
      return;
    }
    this.userId = this.server.join(this);
    const me = this.self();
    queueMicrotask(() => this.emit("joined", me));
    this.server.broadcast(this.userId, "playerJoined", me);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.userId != null) {
      this.server.leave(this.userId);
      this.server.broadcast(this.userId, "playerLeft", { userId: this.userId, name: this.name });
    }
  }

  self() {
    return { userId: this.userId, name: this.name, ...this.pos };
  }

  players() {
    return [...this.server.worlds.values()].filter((w) => w !== this).map((w) => w.self());
  }

  async moveTo(x, y) {
    this.pos = { x, y };
    this.server.broadcast(this.userId, "playerMoved", this.self());
  }
}
