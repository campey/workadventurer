# Roadmap

Where this project is going and why. The README says what exists; this says
what we're building toward, so you can see where a contribution fits.

Work is tracked on the
[workadventurer board](https://github.com/users/campey/projects/1). Issues are
grouped by the three goals below (GitHub milestones of the same names).

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
| G4 | LiveKit escalation and switch-back (4+ person meetings) | not started |
| G5 | Hands-free seam (media-session mute, TalkBack, Bluetooth earbuds) | not started |

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
```

Shared knowledge (what the server really does) lives in
`docs/field-notes.md`, `docs/livekit.md` and `android/docs/field-notes.md`.

## Where to start

- Read the README, then the field notes for the area you're touching.
- Pick an issue from the board; starting one means moving it to In Progress
  (see `CLAUDE.md` for the conventions and the multi-session rules).
- Protocol facts here are verified against a real server, not just code:
  prefer a live check over a unit test when the question is "what does
  WorkAdventure do".
