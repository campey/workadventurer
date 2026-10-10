// In-memory stand-in for the pusher: one instance per scenario, shared by
// every FakeWorld so avatars see each other. No network, no map files.
import { ServerRejectedError } from "../../src/server-rejected.mjs";

export class FakeServer {
  constructor({ acceptedHashes = ["23c8eb8c"], rejectAfterJoin = false } = {}) {
    this.acceptedHashes = acceptedHashes;
    this.rejectAfterJoin = rejectAfterJoin;
    this.worlds = new Map(); // userId -> FakeWorld
    this.nextUserId = 1;
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
  join(world) {
    const userId = this.nextUserId++;
    this.worlds.set(userId, world);
    return userId;
  }

  // scenario: connecting:A version turned away after joining
  leave(userId) {
    this.worlds.delete(userId);
  }

  /** Deliver `event` to every joined world except the sender. */
  // scenario: none yet — WorldPort contract
  broadcast(fromUserId, event, payload) {
    for (const [id, w] of this.worlds) if (id !== fromUserId) w.emit(event, payload);
  }
}
