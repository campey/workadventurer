# Third-party material in the Android app

## Chimes (`app/src/main/res/raw/`)

The four short sounds the app plays when people join or leave your conversation are copied unchanged from the
WorkAdventure project (https://github.com/workadventure/workadventure, tag v1.35.1, `play/public/resources/objects/`), where
its web client plays them in the same situations:

| File here | Upstream file |
|---|---|
| `webrtc_in_ding.mp3` | `webrtc-in-ding.mp3` |
| `webrtc_out_ding.mp3` | `webrtc-out-ding.mp3` |
| `meeting_in.wav` | `meeting-in.wav` |
| `meeting_out.wav` | `meeting-out.wav` |

WorkAdventure is open-source software and these files ship in its repository. The repository does not state a separate licence
for these sound files that I could find (checked 2026-11-25), so they are used and credited as part of that project. If a
licence for them is published, record it here.
