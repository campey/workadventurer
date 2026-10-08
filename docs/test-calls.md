# Test call log

A running history of real calls made with our clients, the Android app and the `wa` CLI: who, where, how it went.
Newest first. This is the human record; measured wire behaviour and bugs go in `field-notes.md` (`docs/` for the CLI,
`android/docs/` for the app), and anything to fix becomes a GitHub issue (link it here).

Add an entry after each call that taught you something, good or bad. A short note is fine.

## Template

```
### YYYY-MM-DD — <room>, with <who>
- Client: android | cli  (build: <commit or version>)
- Setup: <room/server (prod or staging)>, <audio route: handset / speaker / wired / bluetooth (android); TTS / listen mode (cli)>, <network>, <device>
- Length: <minutes>
- How it went: <one or two lines>
- Worked: ...
- Problems: ... (issue #NN)
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

### 2026-10-07 — WorkAdventure staging village, first staging join
- Client: android
- Setup: staging village (`play.staging.workadventu.re/@/tcm/workadventure/wa-village`), phone joined as `android-staging-preset`; a browser player on the other end.
- How it went: joined, saw players and areas, walked to the browser player, joined a bubble and exchanged audio.
- Problems: a red mic on the phone's avatar for the first ~20 s after the phone unmuted, until the browser unmuted. Seen once, not reproduced. Issue #97 (logging added to capture it next time).
