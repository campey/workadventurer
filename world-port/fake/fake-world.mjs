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
        this.emit("rejected", err);
      });
      return;
    }
    this.userId = this.server.join(this);
    const me = this.self();
    queueMicrotask(() => this.emit("joined", me));
    // scenario: none yet — WorldPort contract (playerJoined)
    this.server.broadcast(this.userId, "playerJoined", me);
  }

  // scenario: none yet — WorldPort contract
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
