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
 * @property {(x:number, y:number) => Promise<void>} moveTo  live: walks with the client's pathfinding and resolves when it arrives or stops (a position update only without a collision map); fake: a position update
 * @property {(x:number, y:number) => {x:number,y:number}} openSpotNear  open floor near (x,y), outside every meeting area; live: the nearest non-solid tile centre that is outside all meeting areas; fake: the point unchanged (it states, never computes)
 * @property {() => ({x:number,y:number,w:number,h:number}|null)} startArea  the room's start rectangle, null if none known
 * @property {(x:number, y:number) => boolean} isSolid  throws if the adapter has no answer for that point
 * @property {(spaceName:string, text:string) => void} chat  to the members of a space we are in; they get `chatMessage`
 * @property {(text:string) => void} speechBubble
 * @property {(text:string) => void} thoughtBubble
 * @property {() => void} clearBubble
 * @property {(emoji:string) => void} emote  others get `emote {userId, name, emote}`
 * @property {(playerName:string) => void} invite  invite a known player over; throws if no such player. They get `inviteReceived {name}`, we get `inviteAnswered {accepted, name}`
 * @property {(fromName:string) => Promise<void>} acceptInvite  accept the pending invite from that name; throws if none
 * @property {(on:boolean) => void} setMic  others in our meeting get `peerMic {name, on}`
 * @property {() => Promise<void>} [enableVoice]  live only: attach WaAudio so voice signalling is answered; we then get `voiceSignal {kind:"webrtc"|"livekit", with:string|null}` (with = the peer's name, null if unknown or room-wide). Off by default.
 * @property {(event:string, fn:Function) => void} on  `disconnected {code, reason}` is emitted if the connection drops without us calling close()
 * @property {(event:string, fn:Function) => void} once
 * @property {(event:string, fn:Function) => void} off
 */

export const EVENTS = [
  "joined", "rejected", "playerJoined", "playerMoved", "playerLeft",
  "areaEntered", "areaLeft", "meetingJoined", "meetingLeft",
  "inviteReceived", "inviteAnswered", "chatMessage", "peerMic", "emote",
  "voiceSignal", "disconnected",
];

/**
 * Resolve with the first `event` payload satisfying `predicate`; reject on timeout.
 * The timer is unref'd (a pending waiter never keeps the process alive) and the returned
 * promise has `.cancel()`, which detaches the listener and rejects it with "cancelled".
 */
export function waitFor(port, event, predicate = () => true, timeoutMs = 15000) {
  let cancel;
  const p = new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); port.off(event, onEvent); fn(v); };
    const onEvent = (payload) => { if (predicate(payload)) done(resolve, payload); };
    const timer = setTimeout(() => done(reject, new Error(`timed out waiting for ${event}`)), timeoutMs);
    timer.unref?.();
    cancel = () => done(reject, new Error(`cancelled waiting for ${event}`));
    port.on(event, onEvent);
  });
  p.cancel = cancel;
  return p;
}
