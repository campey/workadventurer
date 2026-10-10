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
    this.invites = new Map(); // "fromId>toId" -> true, while pending
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
    // An avatar in an area meeting is LIVEKIT, not in a proximity bubble.
    // scenario: meetings:A proximity pair walking into a meeting area leaves its bubble for the area meeting
    const ids = [...this.worlds].filter(([, w]) => !w.inAreaMeeting?.()).map(([id]) => id);
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
      // Probe voice-signalling 2026-10-10: a proximity pair sees WEBRTC signalling, no LiveKit invitation.
      // scenario: voice:A proximity pair sets up WEBRTC voice and is not invited to LiveKit
      // Live, A (who walked up) saw with:null and B saw with:"wa-probe-a"; when live fills `with` is not
      // yet probed, so the fake states only what is certain for both: null.
      for (const id of key.split("-")) {
        const w = this.worlds.get(Number(id));
        if (w?.voice) w.emit("voiceSignal", { kind: "webrtc", with: null });
      }
    }
    for (const [key, spaceName] of [...this.pairs]) {
      if (near.has(key)) continue;
      this.pairs.delete(key);
      for (const id of key.split("-")) this.worlds.get(Number(id))?.emit("meetingLeft", { spaceName });
    }
  }

  /**
   * Tell the others about a newcomer, and the newcomer about those already there, one event-loop
   * turn later (live, the announcement trails the join). The payload is read at delivery time;
   * an avatar that left in between is never announced. That identity re-check (the worlds map
   * still holds the same object) replaces clearing the setImmediate timers on close().
   */
  // scenario: invites:An invitation is received, accepted and brings both avatars together
  // scenario: presence:A player's arrival, movement and departure are seen
  announceJoin(world) {
    const tell = (to, subject) => setImmediate(() => {
      if (this.worlds.get(to.userId) !== to || this.worlds.get(subject.userId) !== subject) return;
      to.emit("playerJoined", subject.self());
    });
    for (const other of this.worlds.values()) {
      if (other === world) continue;
      tell(other, world);
      tell(world, other);
    }
  }

  /** Deliver `event` to every joined world except the sender. */
  // scenario: presence:A player's arrival, movement and departure are seen
  broadcast(fromUserId, event, payload) {
    for (const [id, w] of this.worlds) if (id !== fromUserId) w.emit(event, payload);
  }

  /** Deliver `event` to the other members of `spaceName` (the avatars paired in that proximity meeting). */
  // scenario: social:A chat message in a shared meeting reaches the other avatar
  relayToSpace(fromUserId, spaceName, event, payload) {
    for (const [key, name] of this.pairs) {
      if (name !== spaceName) continue;
      const ids = key.split("-").map(Number);
      if (!ids.includes(fromUserId)) throw new Error(`not a member of space ${spaceName}`);
      for (const id of ids) if (id !== fromUserId) this.worlds.get(id)?.emit(event, payload);
      return;
    }
    throw new Error(`not a member of space ${spaceName}`);
  }

  /** The userId of the registered avatar called `name`, or null. */
  idByName(name) {
    for (const [id, w] of this.worlds) if (w.name === name) return id;
    return null;
  }

  /** Space names of the shared meetings `userId` is in. */
  spacesOf(userId) {
    return [...this.pairs].filter(([k]) => k.split("-").map(Number).includes(userId)).map(([, n]) => n);
  }

  /** `fromId` invites `toId` (the caller found it among the players it was told about): the target is told who invited them. */
  // scenario: invites:An invitation is received, accepted and brings both avatars together
  invite(fromId, toId) {
    this.invites.set(`${fromId}>${toId}`, true);
    this.worlds.get(toId).emit("inviteReceived", { name: this.worlds.get(fromId).name });
  }

  /** `toId` accepts the pending invite from `fromName`: the inviter is told. Throws if none pending. */
  // scenario: invites:An invitation is received, accepted and brings both avatars together
  answerInvite(toId, fromName, accepted) {
    const fromId = this.idByName(fromName);
    const key = `${fromId}>${toId}`;
    if (fromId == null || !this.invites.has(key)) throw new Error(`no pending invite from "${fromName}"`);
    this.invites.delete(key);
    this.worlds.get(fromId).emit("inviteAnswered", { accepted, name: this.worlds.get(toId).name });
  }
}
