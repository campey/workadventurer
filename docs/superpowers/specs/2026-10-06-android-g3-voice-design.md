# Android client, G3: voice over the proximity mesh

Design for gate G3 of `2026-10-05-android-client-design.md`. Brainstormed 2026-10-06. Status: spike step 1 done
(see `android/docs/field-notes.md`, "G3 — voice: library spike"); everything below the spike is unbuilt.

## Goal and understanding

The phone talks to and hears people in a WorkAdventure bubble over WorkAdventure's peer-to-peer WebRTC mesh, in the
background with the screen locked, with a working mute. Voice is the point of the app. G3 ends with the spec's live check:
**two-way talk between the phone and a browser peer, no red mic indicator, working with the screen off.**

Staged, not parallel: *hear* a browser peer first, then *speak*, then be the *offerer*. LiveKit (large meetings) is G4 and
is out of scope here, but G3 must not make it harder (one native audio stack).

## Decided

- **Audio stack:** `io.github.webrtc-sdk:android-prefixed:144.7559.14`, the exact libwebrtc build `livekit-android` 2.29.0
  depends on (package `livekit.org.webrtc`). G4 adds `livekit-android` on top: one native stack. Fallback if later steps
  fail against a real browser: Stream's `webrtc-android`, with a re-decision before G4. Never both builds in one app.
- **Role:** the server assigns it per connection. When someone enters a bubble, the *existing* members get
  `webRtcStartMessage{initiator:true}` and send a full (non-trickle) SDP offer; the newcomer gets `initiator:false` and
  answers. The Node client only ever answers; the phone must do both.

## What the spike established (measured on the S25 Ultra)

- The library initialises and produces an offer with Opus audio and the `simplepeer` data channel, with real candidates.
- `ACCESS_NETWORK_STATE` is mandatory: without it the process aborts from a native CHECK, uncatchable.
- ICE gathering started right after the factory is created finds no network (0 candidates, instant "complete"); after
  about 1.5 s it finds them. So the engine is created early, and an offer or answer with zero candidates is a failure.

## Architecture

**`:protocol` (pure JVM) gains space membership**, ported from `src/wa-client.mjs` and the 1.33/1.34 adapter values:
- Server `joinSpaceRequestMessage{spaceName, propertiesToSync}` leads to `JoinSpaceQuery{spaceName, filterType: 0
  (ALL_USERS), propertiesToSync (default cameraState, microphoneState, screenSharingState)}`; the answer carries
  `spaceUserId`. Then send `addSpaceFilterMessage{spaceName}` (without it the server never sets up peer connections for us).
  `leaveSpaceRequestMessage` leads to `removeSpaceFilterMessage` plus `leaveSpaceQuery`.
- Track `spaces: spaceName -> spaceUserId` in `RoomState`; `initSpaceUsersMessage` and add/update/remove space-user
  messages keep a name map (spaceUserId to display name).
- Mic state: `updateSpaceUserMessage{spaceName, user{spaceUserId, microphoneState}, updateMask: ["microphoneState"]}`,
  announced at 0 ms, 1 s and 3 s after joining, and again on `initSpaceUsersMessage` (the red-mic fix, issue #10), only
  while the mic is on; `micOn` is the single source of truth and nothing hard-codes true.
- Private space events both ways: receive `webRtcStartMessage`, `webRtcSignal`, `webRtcDisconnectMessage`; send
  `PrivateSpaceEvent{spaceName, receiverUserId, webRtcSignal{connectionId, signal}}`. Also `iceServersQuery` for TURN/STUN.

**New `:voice` (Android library):**
- `VoiceEngine`: owns the one `PeerConnectionFactory` and the audio device module (echo and noise cancellation, mic
  capture, playout). Created at join, not at the first bubble.
- `PeerLink`: one connection per `connectionId`. Simple-peer signalling: signals are JSON `{type: "offer"|"answer"}` with a
  full SDP (wait for ICE gathering, bounded at 4 s, as the Node client does), `{type: "candidate", candidate}` tolerated,
  `renegotiate` ignored. Creates the `simplepeer` data channel (the browser only reports "connected" once it opens).
  A browser offer always contains `m=video`; libwebrtc should reject it natively, which the next spike step must confirm.
- `MeshSession`: maps start, signal and disconnect events to links; honours the role per connection; drops signals for
  connections already torn down; a pure `PeerLink` interface lets this logic be unit-tested without libwebrtc.
- Stable lifecycle: close the link and its tracks on disconnect, space leave, session end; no per-peer leaks (the Node
  client's issue #29).

**`:app`:** `Command.SetMuted`; `SessionState` gains mute state and who is connected; `PresenceService` (already
foreground type microphone) takes audio focus in communication mode and gets a Mute action on its notification. The
`MediaSession` seam for earbud buttons stays reserved for G5.

## Milestones (each ends with a live check on the phone against a browser peer)

1. **Space join** in `:protocol`, unit-tested with recorded frames. Live: walk into a bubble, the log shows the space
   joined, space users listed, `webRtcStart` received.
2. **Hear:** answer a browser peer's offer (with its `m=video`), play its audio. Live: a browser avatar talks, the phone
   plays it, including with the screen locked.
3. **Speak:** microphone track, mic-state announcements, mute. Live: the browser hears the phone, no red mic, mute and
   unmute work, and the mic stays correct across reconnects and bubble churn.
4. **Offer:** the phone as initiator when a newcomer walks in. Live: a browser avatar joins a bubble the phone is already in.
5. **Soak:** screen locked, 10 minutes, peers coming and going. Live: no leaks, no drops, no red mic.

## Error handling and risks

- Zero-candidate offer or answer: tear the link down, let the server's retry (a fresh `connectionId`) try again.
- Peer failure, close or disconnect: the link is closed once; late signals for a closed id are ignored.
- Microphone permission missing or revoked: the app already refuses to join without it; if revoked mid-session, mute and
  say so instead of crashing.
- Bluetooth routing and audio focus loss (a phone call): out of scope here; must not crash.
- Riskiest assumptions, in order: libwebrtc interoperates with the WorkAdventure browser (video m-line, simple-peer
  quirks); the red-mic behaviour matches the Node findings; background capture survives the lock screen on One UI.

## Testing

Unit tests (JVM) for the signal codec, the space and mic-state reducers, and the mesh state machine against a fake
`PeerLink`. Wire and audio behaviour are proven only by the live checks above (the repo's testing approach); an
instrumented test on the phone covers the library itself.

## Hygiene

Avatar named after the worktree (`g3-voice`); the browser-side peer is a real browser or a Node `wa` daemon on its own
port; leave the room and stop test daemons when done. Never log a space-user uuid or a player's uuid (an email).

## Out of scope

LiveKit (G4), hands-free and earbud controls (G5), video, screen sharing, noise-suppression tuning, a speaking indicator.
