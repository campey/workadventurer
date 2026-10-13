# `wa say`, slice 2: speech over the WebRTC mesh path (#7)

## Goal

`wa say <text>` makes the avatar speak aloud to peers in its bubble. Text goes to
huggingsesame's `say.py --pcm-out`, which streams 24 kHz mono s16le PCM on stdout.
This slice delivers it over the **WEBRTC mesh** transport. The LiveKit transport is
slice 1, built afterwards. No TTS logic lives in Node.

Success: time-to-first-audio and sustained rate are measured; a new `say` interrupts the
current one; `wa status` stays responsive while speaking; hang-up mid-sentence leaves no
orphan `say.py`, `mimi_sidecar.py` or `ffmpeg`; `wa sound` behaves exactly as before.

## Design

### `src/say.mjs` (new): text -> Opus packet stream
`speak(text, { voice, signal })` returns an async iterable of `{ data, samples }`
Opus packets, the same shape `readOggOpus` yields.

1. Spawn `python3 <WA_TTS_SAY> --pcm-out --quiet --backend modal [--voice id] <text>`
   (text via stdin `-` to avoid argv limits and quoting).
2. Pipe its stdout into one persistent
   `ffmpeg -f s16le -ar 24000 -ac 1 -i pipe:0 -c:a libopus -frame_duration 20
   -page_duration 20000 -flush_packets 1 -f ogg pipe:1`.
   `page_duration` is essential, otherwise ~1 s of latency. Probed offline: one Ogg
   page per 20 ms frame, emitted as input arrives.
3. Feed ffmpeg's stdout to the incremental demuxer and yield packets.
4. Teardown (abort signal, early `return()`, or either child exiting): SIGTERM both
   children, await exit, escalate to SIGKILL after 2 s. stdin close counts as cancel.
   A non-zero `say.py` exit with no data yielded surfaces as a thrown error.

### `src/ogg-stream.mjs` (new): incremental Ogg/Opus demuxer
`oggOpusPackets(asyncIterableOfBuffers)` is an async generator: buffers bytes, parses
whole pages (capture pattern, segment table, lacing across pages), skips `OpusHead` and
`OpusTags`, yields audio packets with sample counts from the TOC byte. It sits beside
`readOggOpus` in `src/ogg-opus.mjs`, which is untouched apart from exporting its
`opusSamples` helper. Unit-tested with
split-at-every-offset inputs.

### `WaAudio` (`src/wa-audio.mjs`)
- Extract the per-packet loop of `_playWebrtc` into `_pump(packets, { token, indicator })`
  taking an async iterable. `_playWebrtc` becomes: demux the file, call `_pump` over the
  array. Existing behaviour and result shape are preserved.
- `_pump` prebuffers about 500 ms (25 packets) before the first RTP packet. If the source
  underruns (next packet later than its wall-clock slot), the pump marks the next packet
  `marker: true` (new talkspurt), re-bases its clock, and advances `p.ts` over the gap.
  A short stream (< 500 ms) flushes at end.
- `say(text, opts)`: claims `_play` synchronously like `play()`, runs
  `speak()` -> `_pump`, uses `_setSpeaking`. On the WEBRTC transport only in this slice;
  with `this._livekit` set it returns `{ played: false, reason: "livekit say not
  implemented yet" }`. `hangup()` already calls `this._play.stop()`; the token's `stop`
  also aborts the `speak()` signal.
- A new `say` supersedes the running one (stop, then start), the same rule as `play`.

### Daemon, CLI, config
- `POST /say {text, voice?}`: validate, 503 if audio not ready, `waitForLiveKit()`,
  409 if no one is in the bubble, then fire-and-forget `audio.say()` and reply 202.
  `POST /say-cancel` stops the current utterance. Both mirror `/sound`.
- `wa say <text...> [--voice id]` and `wa say --cancel`.
- `src/config.mjs`: `WA_TTS_PYTHON` (default `python3`) and `WA_TTS_SAY` (default
  `~/Code/huggingsesame/src/say.py`), passed through `configToEnv`. The API token stays
  with `say.py`'s own lookup and is never read or logged here.

## Testing

- Unit: Ogg demuxer (page splits, lacing, header skipping); `_pump` timing with real timers and
  generous tolerances (prebuffer, underrun -> marker, cancel mid-stream); `speak()` teardown with a
  fake child.
- Offline end-to-end: a stub `WA_TTS_SAY` that cats the `hello_34f.csmr` fixture through
  `mimi_sidecar.py`, daemon on a free port, avatar `wa-say`, a real browser peer joined to
  hear it (two headless werift peers cannot complete ICE on one host). Check first-audio latency, rate, interrupt, hang-up, `pgrep` for orphans.
- Live cloud demo only after the offline run passes, after the user confirms the
  `--hello` handshake line, and with `modal_ctl.py cool` afterwards.
- Regression: `wa sound` and the `scripts/selfcheck.mjs` run unchanged.

## Out of scope for this slice
LiveKit `say` (slice 1), voice cloning, queueing multiple utterances, speaking only when
a bubble exists beyond the 409 check, and any change to `say.py`.
