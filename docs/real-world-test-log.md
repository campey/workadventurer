# Real-world test log

Calls made with **other people** on the line, using our clients: the Android app and the `wa` CLI. Newest first.
Solo tests and experiments (just the owner and Claude) go in `experimental-test-log.md`.

This is the human record of how it went. Measured wire behaviour and bugs go in `field-notes.md` (`docs/` for the CLI,
`android/docs/` for the app); anything to fix becomes a GitHub issue (link it here). Add an entry after each call that
taught you something, good or bad. A short note is fine. Other people are named only when the owner has said to.

## Template

```
### YYYY-MM-DD — <room>, with <who>
- Client: android | cli  (build: <commit or version>)
- Setup: <room/server (prod or staging)>, <audio route: handset / speaker / wired / bluetooth (android); listen/TTS mode (cli)>, <network>, <device>
- Length: <minutes>
- How it went: <one or two lines>
- Worked: ...
- Problems: ... (issue #NN)
- Log: <the call's log file, e.g. 2026-10-08T09-12-03_afrolabs-afrolabs-open-space.log, from "Share logs" in the app; summarise with `node android/tools/call-log-summary.mjs <file>`>  (android only; since #98)
```

## Entries

### 2026-10-08 — WorkAdventure staging, with David (WorkAdventure)
- Client: android
- Setup: staging village (`play.staging.workadventu.re`), call taken while driving in a car.
- How it went: stable for the whole call. His reaction: "wow".
- Worked: voice stayed stable on the move.
- Problems: none noted.

### 2026-10-08 — Afrolabs open space, with Diccon (Afrolabs)
- Client: android
- Setup: prod, `afrolabs/afrolabs/open-space`, in a meeting area. Audio started on the handset, then a wired headset was plugged in mid-call.
- Length: about 60 minutes.
- How it went: successful, no issues noted.
- Worked:
  - The route change from handset to a plugged-in headset did not disturb the call.
  - Speaking with the screen locked.
  - Pressing the power button did not hang up (a requirement for the telephony work, issue #85).
- Not tried: muting from the notification, mute surviving a reconnect.

### 2026-10-05 — fire pit call, 5–6 people (prod), speech-to-text listener
- Client: cli (`wa join --stt`, branch for PR #44, a LiveKit-transport listener avatar; no audio published)
- Setup: prod, the fire pit meeting. The bubble grew past the P2P limit and the server switched everyone to LiveKit mid-call.
- Length: several minutes of continuous multi-speaker transcription during the call.
- How it went: the long-standing crash fix held under real load: no CPU/RSS blow-up (daemon ~15–25 %, worker peaks ~98 %, RSS ~125 MB against the 1 GB+ crash signature). Transcripts flowed with correct speaker attribution.
- Worked: LiveKit escalation with a listener in the room; live `SCRIBE[...]` lines per speaker; the owner then ran it in the foreground to watch it.
- Problems found live:
  - Prod had upgraded to v1.34 minutes before the call and rejected every client (`NEW_VERSION`). Fixed on the spot with the new API hash (`23c8eb8c`); the adapter work followed.
  - Only two people were being transcribed, one of them muted, so a person who was talking was skipped (the listener caps concurrent STT streams). The owner questioned whether the cap is needed at all; investigating it on a bench of synthetic speakers found the late-joiner bug below.
  - Transcript showed whisper-tiny hallucinations: a word repeated 150+ times that the repetition guard missed (fixed, test added), and text in a language nobody spoke.
  - A participant already in the room when the listener connected could be silently skipped; fixed later the same day on a bench of synthetic speakers.

### 2026-09-09 — campus meeting room, four people present
- Client: cli (`wa` daemon, avatar standing in the room)
- Setup: prod, `lean-iterator/campus`, "Lean Coffee Table 1" meeting area with four people in it.
- How it went: the avatar stood in the middle of the group and the server sent it no group, space or WebRTC messages at all, so there was no voice channel and `wa sound` had nobody to play to ("no one in the bubble to hear it"). Only the avatar's speech bubble worked.
- Learned: that table is a per-area LiveKit room (`livekitRoomProperty`), not proximity WebRTC. The CLI neither detected the area nor spoke LiveKit. Led to the area-meeting and LiveKit-transport work (#8, #13).
