# Experimental test log

Tests and experiments done **by the owner with Claude** (no other people on the line), on the Android app and the `wa` CLI.
Newest first. Calls with other people go in `real-world-test-log.md`.

Backfilled from the session transcripts on 2026-10-08, so entries from before then are summaries of what was said at the time
(the owner's own reactions, quoted where useful); exact numbers and root causes live in `field-notes.md` (`docs/` for the CLI,
`android/docs/` for the app) and in the issues linked.

## Template

```
### YYYY-MM-DD — <what was tried>
- Client: android | cli  (build: <commit or version>)
- Setup: <room/server>, <who/what was on the other end: browser, second browser, synthetic avatars>, <device>
- Result: <what happened>
- Learned / follow-up: ... (issue #NN)
- Log: <the call's log file from "Share logs", if any>  (android only; since #98)
```

## Android

### 2026-10-07 — first join to the WorkAdventure staging village
- Client: android (branch `android-staging-preset`, PR #96)
- Setup: `play.staging.workadventu.re/@/tcm/workadventure/wa-village`, phone as `android-staging-preset`, the owner in a browser.
- Result: joined, saw players and areas, walked to the browser player, joined a bubble and exchanged audio.
- Learned / follow-up: staging needs its own pusher and woka id (now picked from the room host). A red mic on the phone's avatar for ~20 s after it unmuted, until the browser unmuted; seen once, not reproduced (#97, offer logging added).

### 2026-10-06 / 07 — G3 M3: speaking, mute, muted browsers, meeting areas
- Client: android (branch `android-g3-voice`, PR #95)
- Setup: prod, phone (Samsung S25 Ultra) against a browser, bubbles and the campus meeting areas.
- Result: two-way audio with the browser as answerer and offerer; no red mic on the phone; mute/unmute shown correctly in the browser. A browser that joined muted was inaudible after unmuting until the phone could answer a second offer and re-offer on request (two bugs found live, fixed, on-device tests added). On the campus map the avatar walked through furniture and spawned in the wrong place (fixed, PR #91).
- Learned / follow-up: see `android/docs/field-notes.md`, "G3 M3 live check". Open: mic indicator stays lit while muted by design; LiveKit escalation not handled (G4).

### 2026-10-06 — G3 M2: hearing a browser peer
- Client: android
- Setup: prod, phone entering a bubble with a browser.
- Result: audio from the browser heard, but only ~21 s after entering the bubble: the server expects the already-present member to offer and the phone only knew how to answer. Adding the offerer role brought it to ~1.25 s.
- Learned / follow-up: `android/docs/field-notes.md`, "G3 M2 live check".

### 2026-10-06 — G3 M1: joining spaces and bubbles
- Client: android
- Result: the owner walked up to the phone and away; the phone joined the bubble's space within a second of arriving and left in the right order. Being the already-present member, the phone was told to send the offer (`initiator=true`), which made the offerer role matter.
- Learned / follow-up: `android/docs/field-notes.md`, "G3 M1 live check".

### 2026-10-05 / 06 — G1 presence on the real phone, G2 movement
- Client: android (Galaxy S25 Ultra, Android 16)
- Result: avatar stays present on a locked phone; follow and walk-to work on the real map.
- Learned / follow-up: `android/docs/field-notes.md`, "G1 — real phone" and "G2 live checks".

## CLI

### 2026-10-06 — recording real speech for the STT quality corpus
- Client: cli (`stt-quality` listener avatar, `STT_TEE_DIR` capture)
- Setup: prod, the owner talking to a listener avatar next to them: normal sentences, silence with the mic open, bare words, a few seconds of a language on purpose (the owner didn't speak it, so the resulting text was a hallucination, which was wanted for the corpus).
- Result: the first round captured nothing because the P2P path wasn't covered by the tee (fixed); later rounds recorded audio and finals. Walked to the wrong one of two avatars with the same name once.
- Learned / follow-up: wrong-language hallucination and filler on silence (#61 and the STT issues #56–#66).

### 2026-10-05 — STT bench with synthetic speakers
- Client: cli (a listener plus four speaker avatars, no humans)
- Result: found the listener silently skipping a participant already in the room when it connected, plus a connect race; both fixed with tests that fail on the old code.
- Learned / follow-up: #44.

### 2026-09-14 — LiveKit publish and subscribe, the buzz
- Client: cli (branch for #8)
- Setup: a LiveKit bubble of 4 players; the owner listening on one machine, later on another with headphones.
- Result: first nothing audible, then a low-frequency rumble, then a 1 kHz tone with a glitch, then a steady ~50 Hz buzz. Real receive was proven separately (301 frames of the owner's mic). Two causes were found by listening: chunk views sharing a buffer (`.subarray()` byte offset made every chunk repeat the same first 20 ms) and, earlier, a tight-loop crash approaching crowded bubbles. After the fix: "it worked!" and "perfect".
- Learned / follow-up: `docs/livekit.md`. Later the same day: joining the fire-pit conversation alone made `wa sound` say "no one in the bubble to hear it" until leaving and rejoining; fixed.

### 2026-09-13 — agent with several humans and agents
- Client: cli
- Result: with two browsers, the chime was heard on both. Two agents plus one human crashed; two humans plus one agent worked. With four in the bubble and the daemon, a red mic appeared again. Earlier the same day the owner reported a regression: the mic stayed red and `wa sound chime` did nothing, though the chime was then heard.
- Learned / follow-up: the owner asked not to jump to conclusions after a day's gap; commented on the three-way chat issue.

### 2026-09-10 — the red mic
- Client: cli
- Setup: the owner walking up to the `claude` avatar to form a bubble, watching its mic indicator.
- Result: the owner's diagnosis: the mic is red until an audio stream starts; send a chime and it clears. Fix tried: a continuous silent stream. It made the avatar's media fail to attach and OOM-killed the daemon in about 2 minutes (werift's un-awaited send fan-out). The owner then found that after just one chime the mic stayed open, so a single short silence on connect was enough. A bounded silence prime fixed it with RSS flat over 90 s (54→63 MB).
- Learned / follow-up: #10; never run a continuous keepalive stream.

### 2026-09-08 / 09 — first sounds into WorkAdventure
- Client: cli
- Result: the owner heard a first clip (an ogg), then a chime, then a synthesized Claude intro. A demo run (clear the bubble, walk away, thought bubble for 5 s, walk back, play the greeting): "that was perfect". Next day: the mic indicator was red and the media window missing in some spots, and the owner noticed it took a long time before the chime was sent.
- Learned / follow-up: #6 sounds; the road to agent speech (#7, #12).
