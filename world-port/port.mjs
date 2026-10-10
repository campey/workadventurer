// The World Port: the one surface scenarios talk to. Implemented by the fake
// (offline, default) and the live adapter (WORLD=live).

/**
 * @typedef {{userId:number, name:string, x:number, y:number}} PlayerInfo
 *
 * @typedef {object} WorldPort
 * @property {() => Promise<void>} connect  rejects with ServerRejectedError (src/server-rejected.mjs)
 * @property {() => void} close  idempotent
 * @property {() => PlayerInfo} self
 * @property {() => PlayerInfo[]} players
 * @property {(x:number, y:number) => Promise<void>} moveTo  position update, no pathfinding
 * @property {() => ({x:number,y:number,w:number,h:number}|null)} startArea  the room's start rectangle, null if none known
 * @property {(x:number, y:number) => boolean} isSolid  throws if the adapter has no answer for that point
 * @property {(event:string, fn:Function) => void} on
 * @property {(event:string, fn:Function) => void} once
 * @property {(event:string, fn:Function) => void} off
 */

export const EVENTS = [
  "joined", "rejected", "playerJoined", "playerMoved", "playerLeft",
  "areaEntered", "areaLeft", "meetingJoined", "meetingLeft",
  "inviteReceived", "inviteAnswered", "chatMessage", "peerMic", "emote",
];

/** Resolve with the first `event` payload satisfying `predicate`; reject on timeout. */
export function waitFor(port, event, predicate = () => true, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); port.off(event, onEvent); fn(v); };
    const onEvent = (payload) => { if (predicate(payload)) done(resolve, payload); };
    const timer = setTimeout(() => done(reject, new Error(`timed out waiting for ${event}`)), timeoutMs);
    port.on(event, onEvent);
  });
}
