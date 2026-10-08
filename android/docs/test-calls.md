# Test call log

A running history of real calls made with the Android app: who, where, how it went. Newest first. This is the human
record; measured wire behaviour and bugs go in `field-notes.md`, and anything to fix becomes a GitHub issue (link it here).

Add an entry after each call that taught you something, good or bad. A short note is fine.

## Template

```
### YYYY-MM-DD — <room>, with <who>
- Setup: <room/server (prod or staging)>, <audio route: handset / speaker / wired / bluetooth>, <network>, <phone>, build <commit or version>
- Length: <minutes>
- How it went: <one or two lines>
- Worked: ...
- Problems: ... (issue #NN)
```

## Entries

### 2026-10-08 — WorkAdventure staging, with David (WorkAdventure)
- Setup: staging village (`play.staging.workadventu.re`), call taken while driving in a car.
- How it went: stable for the whole call. His reaction: "wow".
- Worked: voice stayed stable on the move.
- Problems: none noted.

### 2026-10-08 — Afrolabs open space, with Diccon (Afrolabs)
- Setup: prod, `afrolabs/afrolabs/open-space`.
- How it went: a normal call, no issues noted.
- Problems: none noted.

### Long meeting-area session (about 1 hour) — date and peer to confirm
- Setup: prod, in a meeting area. Audio started on the handset, then a wired headset was plugged in mid-call.
- Length: about 60 minutes.
- How it went: successful.
- Worked:
  - The route change from handset to a plugged-in headset did not disturb the call.
  - Speaking with the screen locked.
  - Pressing the power button did not hang up (a requirement for the telephony work, issue #85).
- Not tried: muting from the notification, mute surviving a reconnect.

### 2026-10-07 — WorkAdventure staging village, first staging join
- Setup: staging village (`play.staging.workadventu.re/@/tcm/workadventure/wa-village`), phone joined as `android-staging-preset`; a browser player on the other end.
- How it went: joined, saw players and areas, walked to the browser player, joined a bubble and exchanged audio.
- Problems: a red mic on the phone's avatar for the first ~20 s after the phone unmuted, until the browser unmuted. Seen once, not reproduced. Issue #97 (logging added to capture it next time).
