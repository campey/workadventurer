// In-memory stand-in for the pusher: one instance per scenario, shared by
// every FakeWorld so avatars see each other. No network, no map files.
import { ServerRejectedError } from "../../src/server-rejected.mjs";

export const PROXIMITY_PX = 64;

export class FakeServer {
  constructor({ acceptedHashes = ["23c8eb8c"], rejectAfterJoin = false } = {}) {
    this.acceptedHashes = acceptedHashes;
    this.rejectAfterJoin = rejectAfterJoin;
    this.worlds = new Map(); // userId -> FakeWorld
    this.nextUserId = 1;
    this.pairs = new Map(); // "lo-hi" userId pair -> shared meeting name, while within PROXIMITY_PX
  }

  // scenario: connecting:Our version is accepted
  accepts(hash) {
    return this.acceptedHashes.includes(hash);
  }

  /** The rejection a stale client build gets (code NEW_VERSION => isVersionRejection). */
  // scenario: connecting:A stale version is turned away
  newVersionError() {
    return ServerRejectedError.fromMessage({
      code: { value: "NEW_VERSION" },
      title: { value: "New version available" },
      details: { value: "Please reload the page" },
      timeToRetry: { value: 999999 },
    });
  }

  // scenario: connecting:Our version is accepted
  // scenario: connecting:A version turned away after joining
  join(world) {
    const userId = this.nextUserId++;
    this.worlds.set(userId, world);
    return userId;
  }

  // scenario: connecting:A version turned away after joining
  leave(userId) {
    this.worlds.delete(userId);
    // Pairs involving the leaver end; the leaver is already gone, so notify only the other side.
    for (const [key, spaceName] of [...this.pairs]) {
      const [a, b] = key.split("-").map(Number);
      if (a !== userId && b !== userId) continue;
      this.pairs.delete(key);
      this.worlds.get(a === userId ? b : a)?.emit("meetingLeft", { spaceName });
    }
  }

  /**
   * Put avatars within PROXIMITY_PX of each other in a shared meeting: both get
   * `meetingJoined` with the same `spaceName` when they come together and
   * `meetingLeft` when they part. Called after every join, move and leave.
   */
  // scenario: presence:Walking next to another avatar puts both in the same meeting
  updateProximity() {
    const ids = [...this.worlds.keys()];
    const near = new Set();
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        const p = this.worlds.get(a).pos, q = this.worlds.get(b).pos;
        if (Math.hypot(p.x - q.x, p.y - q.y) <= PROXIMITY_PX) near.add(`${a}-${b}`);
      }
    }
    for (const key of near) {
      if (this.pairs.has(key)) continue;
      const spaceName = `proximity-${key}`;
      this.pairs.set(key, spaceName);
      for (const id of key.split("-")) this.worlds.get(Number(id))?.emit("meetingJoined", { spaceName });
    }
    for (const [key, spaceName] of [...this.pairs]) {
      if (near.has(key)) continue;
      this.pairs.delete(key);
      for (const id of key.split("-")) this.worlds.get(Number(id))?.emit("meetingLeft", { spaceName });
    }
  }

  /** Deliver `event` to every joined world except the sender. */
  // scenario: presence:A player's arrival, movement and departure are seen
  broadcast(fromUserId, event, payload) {
    for (const [id, w] of this.worlds) if (id !== fromUserId) w.emit(event, payload);
  }
}
