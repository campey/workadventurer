# Roadmap

Where this project is going and why. The README says what exists; this says
what we're building toward, so you can see where a contribution fits.

Work is tracked on the
[workadventurer board](https://github.com/users/campey/projects/1). Some of the
goals below (accessibility, car mode, agent social cues) don't have issues yet;
they're deliberately left here until they're ready to be broken down.

## Why this exists

WorkAdventure is a browser-first virtual office. This project is a **headless
client** for it (no browser, no game engine), built so that people and agents
can be present in a space without a desktop browser tab. Three goals drive it.

### 1. A robust Android client: present from the car

Be present in a WorkAdventure space during a 1.5 hour commute (one or two days
a week), natively, without the current workaround of Jitsi rooms. The UX has to
be usable in a car: voice-first, big targets, hands-free mute and unmute, and
audio that behaves with Bluetooth and car systems.

Lives in `android/` (Kotlin); it will graduate to its own `workadventure-app`
repo once G4 passes. Progress is tracked as learning gates, one at a time:

| Gate | Question | State |
|---|---|---|
| G0 | Does a Kotlin client get past the pusher? | done |
| G1 | Does presence survive on a phone (screen locked)? | done |
| G2 | Can it move (pathfinding port)? | done |
| G3 | Two-way mesh audio with browser peers? | live-checked; review minors in #105 |
| G4 | LiveKit escalation and switch-back (4+ person meetings) | in progress (#134): main hears LiveKit invitations and logs offers it cannot answer; the LiveKit join itself is on the `android-livekit-escalation` branch, in review, not on `main` yet |
| G5 | Hands-free seam (media-session mute, TalkBack, Bluetooth earbuds) | partly done: Bluetooth audio routing (#164). Checked on hardware by the maintainer: a Bluetooth headset works, stays stable on long calls, and switching between audio sources works. Not done: media-key (play/pause) mute, TalkBack |

Audio routing (what is built for G5): speaker by default, a headset takes over when it connects, the microphone
follows the chosen device, a device picker in the audio sheet, Bluetooth headsets as call devices (`BLUETOOTH_CONNECT` is
asked with the other permissions).

**Adapters keep up with the server.** A production version bump used to break the CLI and the APK until someone shipped
a new hash. Now a catalog of gated adapters (`catalog/`), an hourly watcher that tests and publishes them, and recovery
in the CLI and the app (with the user's consent) mean a routine bump no longer breaks either. See the README's "Version
targets" and the [design](superpowers/specs/2026-11-10-downloadable-adapters-design.md).

Epic: #54. Design: `docs/superpowers/specs/2026-10-05-android-client-design.md`.
Findings per gate: `android/docs/field-notes.md`.

### 2. Decent presence for agents and bots

a. **A Claude that can come and get your attention**, with social cues (walk
   over, don't barge in) and a real speech loop: STT to hear you, TTS to talk
   back. Today: the avatar walks, greets, shows bubbles and plays sounds; TTS
   (#7) and the live-voice bridge (#12, a backend-agnostic socket for dropping
   a voice AI into the room) are next.

b. **A scribe**: joins a conversation, captions what is said into the chat
   (working: `wa join --stt`), writes a transcript, and produces useful
   summaries. Related: #40, #42, #64, #60.

c. **The "world of workcraft" idea**: an avatar per pull request, task or
   email. Risk: it becomes an overwhelming swarm, so it needs a social-cue
   model first (who may approach whom, when, and how loudly). Design only so
   far.

### 3. Blind accessibility

Make WorkAdventure usable for blind people, particularly the community around
[tapeaids.com](https://tapeaids.com), which the maintainer builds software for.
This is driven from the mobile app plus a screen reader. People driving
shouldn't look at the screen either, so goals 1 and 3 share foundations
(audio-first navigation, spoken state of the room and who's nearby), but
blind power users are heavy screen-reader users and need their own interaction
design on top. Upstream has the same gap: workadventure/workadventure#1055.

## How the pieces fit

```
wa CLI / daemon (Node)  ──┐
Claude Code plugin      ──┼── src/: pusher WebSocket + protobuf, pathfinding,
STT listener (--stt)    ──┘        WebRTC / LiveKit audio, per-version adapters
Android app (Kotlin)    ───── its own protocol + voice stack; shares only proto/
catalog/ + adapter watcher ── adapters for new server versions: the CLI and the app fetch them
```

Shared knowledge (what the server really does) lives in
`docs/field-notes.md`, `docs/livekit.md` and `android/docs/field-notes.md`. A new server version reaches the clients
through `catalog/` (published by `.github/workflows/adapter-watch.yml`) rather than a release.

## Where to start

- Read the README, then the field notes for the area you're touching.
- Pick an issue from the board; starting one means moving it to In Progress
  (see `CLAUDE.md` for the conventions and the multi-session rules).
- Protocol facts here are verified against a real server, not just code:
  prefer a live check over a unit test when the question is "what does
  WorkAdventure do".
