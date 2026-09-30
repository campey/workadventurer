# LiveKit transport (issue #8)

Everything learned building and debugging the LiveKit path, consolidated in
one place since it keeps growing. This is the "why is it doing that"
companion for `src/wa-audio.mjs`'s LiveKit half — see `README.md`'s
`## The protocol` for the message reference and `docs/field-notes.md` for
non-LiveKit findings.

---

## Transport model

A proximity meeting starts as a P2P WEBRTC mesh (one `RTCPeerConnection`
per remote peer). **Escalation to a LiveKit SFU is driven by mesh size, not
by area type.** `switchMessage`/`finalizeSwitchMessage{strategy:"LIVEKIT"}`
are informational only — the actual trigger to connect is
`livekitInvitationMessage{token, serverUrl}`, and it isn't guaranteed to
arrive in any particular order relative to the switch messages. Don't gate
connecting on the switch messages; gate it on the invitation.

**A named/"meeting" area (a `livekitRoomProperty` area — a "fire pit", a
lounge table, etc.) does *not* mean the meeting is on LiveKit.** This was a
wrong assumption made and then corrected live (see PR #45 vs. #46 below):
with just one or two people in such an area, WA keeps the meeting on plain
WEBRTC exactly like an ad-hoc proximity bubble. The area property enables
LiveKit as *available* for that space; it only actually escalates past WA's
own mesh-size threshold. Don't assume "named area → LiveKit" anywhere —
check `WaAudio`'s actual transport state (`this._livekit` vs. `this.peers`),
or better, reproduce live and read the daemon log's `audio ·` lines
(`webRtcStart` vs. `LiveKit connected`) before trusting a theory about which
transport is active.

## Library

**`@livekit/rtc-node`**, not `livekit-client` (browser-only) or
`livekit-server-sdk` (admin/token-only, no media). Native napi-rs bindings
(`@livekit/rtc-ffi-bindings-darwin-arm64` etc., prebuilt) — this project's
first native dependency. The public API was verified against the installed
package's own `.d.ts`/`.cjs` and README before writing any integration code,
not assumed from docs alone — worth doing again if this package majors.

## Publish

- **Needs raw PCM, not Opus.** `AudioSource(sampleRate, channels)` →
  `LocalAudioTrack.createAudioTrack(name, source)` →
  `room.localParticipant.publishTrack(track, opts)` (`opts.source =
  TrackSource.SOURCE_MICROPHONE`) → `source.captureFrame(new
  AudioFrame(int16Samples, sampleRate, channels, samplesPerChannel))` per
  chunk. `src/transcode.mjs`'s `ensurePcm()` is the sibling to `ensureOpus()`
  for this — `ffmpeg -f s16le`, same mtime+size cache pattern.
- **`captureFrame()` does not self-pace, and that's fine — don't pace it
  yourself either.** Reading the actual implementation (not just the types)
  shows it only awaits the FFI round-trip that confirms the frame was
  *accepted* into the native jitter buffer, not real playback time. It's
  tempting to read that as "so I must pace my own calls to real-time" (the
  WEBRTC/RTP path does exactly that, since raw RTP has no buffer of its
  own) — but `AudioSource` already has its own internal jitter buffer
  (`queueSize`, default 1000ms — bump it if a clip is longer than that) and
  paces *actual playout* itself. `_playLiveKit()` feeds 20ms chunks
  back-to-back with no pacing of its own; `captureFrame()`'s own await is
  throttling enough. (An external wall-clock pacer was tried first, on the
  theory that skipping it would starve the buffer — that theory was wrong;
  see the `.slice()` bug below for what the buzz it seemed to explain
  actually was.)
- **The `.slice()`-vs-`.subarray()` footgun is worse than LiveKit's own docs
  make it sound — it silently corrupts data, not just risks a crash.**
  `AudioFrame.protoInfo()` (inside `@livekit/rtc-node` itself) hands the
  native FFI side `this.data.buffer` directly, ignoring the typed array's
  own `byteOffset`/`length` entirely. Chunk a longer buffer with
  `.subarray()` and every chunk's data pointer resolves to byte 0 of the
  *whole original buffer*, regardless of which chunk you meant — not a
  crash, not an exception, just silently wrong audio. For repeated 20ms
  playback chunks, that means every single frame sent is actually the
  clip's first 20ms, over and over: a perfectly periodic artifact at the
  frame rate (50 times/second → an audible ~50Hz buzz, confirmed live —
  its suspiciously exact frequency was the tell). `.slice()` on a plain
  `Int16Array` copies into a fresh, independent, zero-offset buffer, which
  is what this FFI binding actually needs. This is the *reverse* of the
  usual `Buffer` advice (there, `.slice()` is the view/footgun and
  `.subarray()` the safe copy-avoiding choice) — the direction flips
  because `Buffer.prototype.slice` is a Node-specific override, while a
  plain `Int16Array`'s `.slice()`/`.subarray()` follow the standard
  ECMAScript TypedArray contract (`.slice()` copies, `.subarray()` views).
  Don't assume the convention carries over just because the method names
  match.
- **`dispose()` is process-global, one-shot — not per-room.** It releases
  the shared FFI runtime for the whole process. Call it once at daemon
  shutdown (`disposeLiveKitRuntime()` in `wa-daemon.mjs`'s SIGINT/SIGTERM
  path), never inside a per-`livekitDisconnectMessage` handler — a meeting
  can de-escalate and re-escalate LiveKit more than once in one daemon's
  lifetime, and disposing the runtime mid-session would break every
  subsequent connect attempt. `WaAudio` tracks module-level "was LiveKit
  ever used this process" so the shutdown call is a no-op for the (common)
  case of a daemon that never escalates.
- **`_livekitConnecting` bridges "invitation received" and "actually
  connected".** `_connectLiveKit()`'s `room.connect()` +
  `publishTrack()` can take a real, user-visible amount of time for an
  actual SFU. `WaAudio.waitForLiveKit(timeoutMs)` waits out an in-flight
  connect (bounded) instead of racing it — `/sound`'s guard uses this so a
  chime fired right after an escalation doesn't 409 with "no one in the
  bubble to hear it" just because the connect hadn't finished yet. This is
  a real fix (PR #45) for a real scenario (a meeting that *does* escalate),
  but it was initially — wrongly — assumed to be the explanation for a bug
  that turned out to be pure WEBRTC (see below).

## WEBRTC codec negotiation against real browser peers (PR #46)

Found live, immediately downstream of the "named area ≠ LiveKit" correction
above. Reported symptom: joining a named meeting area with a single other
real player, `/sound` 409'd with `no one in the bubble to hear it` right
after joining; rejoining sometimes "fixed" it. This looked LiveKit-shaped
(see #45 above) but wasn't — live testing (joining the user's own session,
`SDP_DEBUG`-capturing the real SDP) showed the meeting was on plain WEBRTC
the whole time, `peers:1, connected:false`.

**Root cause:** a real WA browser peer's SDP offer always includes an
`m=video` section, even with the camera off. Our `RTCPeerConnection` only
ever declared an audio codec (`codecs: { audio: [OPUS] }`), but werift's
`TransceiverManager.setRemoteRTP()` throws unconditionally whenever a media
section's codec list, filtered against local config, comes up empty — it
doesn't distinguish "we don't support this *kind* at all" from "we do but
nothing overlapped". Since `m=video` sorts before `m=audio` in a real
browser's offer, that throw happened before the perfectly compatible audio
section right after it was ever processed, killing the whole connection
(`negotiate codecs failed`). **This only hits the real-browser-peer
answering path** (`initiator=false`, i.e. we're responding to *their*
offer) — two headless daemons never trip it, since neither side's offer
ever includes video, which is why werift-to-werift testing never surfaced
it and it took a real human peer to find.

**Fix:** declare `video: [useVP8()]` too (imported from `werift`), matching
werift's own `generateDefaultPeerConfig()` default — the project's
audio-only override had silently dropped it. We never add our own video
transceiver; werift auto-creates a recvonly one for the remote's `m=video`
section and nothing downstream reads from it — this is purely to let codec
negotiation for that section succeed instead of throwing.

**A wrong fix was tried first and is worth remembering as a trap:**
stripping the `m=video` section out of the raw SDP text before
`setRemoteDescription()`. That avoids the codec throw, but WebRTC requires
strict positional correspondence between offer and answer `m=` sections —
removing one outright broke a *later* ICE candidate for the now-missing
video mid (`Media section for sdpMid was not found`, a different crash).
Fix the codec *configuration*, not the wire format; don't hand-edit SDP to
route around a negotiation gap unless you're also prepared to keep every
positional/mid reference consistent afterward.

**Testing technique worth reusing:** `SDP_DEBUG=<dir>` (already in
`wa-audio.mjs`, gated on the env var) dumps every offer/answer to disk.
The exact SDP that reproduced this crash live is checked in as a test
fixture (`test/fixtures/live-browser-offer-with-video.sdp`) and
`test/wa-video-codec-negotiation.test.mjs` runs it through **real
werift** (`RTCPeerConnection.setRemoteDescription()`), not a mock — one
test proves the bug against the exact peer-connection config `WaAudio`
uses, the other proves the fix, both against a real captured production
payload rather than a synthetic approximation.

## Receive (subscribe) — not yet built

A throwaway diagnostic that set `autoSubscribe: true` and read a few
`RemoteTrack`s via `AudioStream` (to check whether the room routes media to
us at all) reliably crashed the daemon — CPU to 300%+, RSS to 1GB+ within
about a minute — until it was rewritten to call `stream.getReader()` + an
explicit `reader.cancel()` in a `finally` block; merely `break`-ing out of
a `for await` loop early was not enough to stop the native side from
continuing to push frames into an unconsumed queue. With that explicit
cancel it worked cleanly (confirmed receiving real, non-silent human
audio — 301 frames, RMS in the hundreds-to-thousands range). The
diagnostic itself was never shipped (reverted after confirming it), but
whoever builds the real subscribe path should call `reader.cancel()`
explicitly, every time, not rely on early-break cleanup.

Once built, this would let STT work over LiveKit too — and should actually
be *simpler* than the current WEBRTC route, since `AudioStream` hands you
PCM directly instead of Opus RTP that needs muxing to Ogg and
ffmpeg-decoding.

## Status

- **Connect + publish (issue #8): done.** Verified at the SDK/protocol
  level and, after the two publish-path bugs above, confirmed audible and
  correct by a human listener on two separate physical machines/headphones,
  for both a short clip and real speech.
- **The connect-race guard (PR #45) and the codec negotiation fix (PR #46):
  done, both live-verified**, including rejoining the reporter's own live
  session and having them confirm hearing a chime played through the
  fixed path.
- **Subscribe, and robust switch-back-to-WEBRTC if a meeting shrinks below
  the threshold mid-session: not yet built.** Explicit, scoped-out
  follow-ups.

## Related, but not LiveKit-specific

While live-testing the publish path, a *separate*, unrelated bug was found
and fixed: `_navTo` (`src/wa-client.mjs`) could spin unthrottled while
approaching a crowded/jittery bubble, pinning CPU and making the daemon
unresponsive to SIGTERM. It's not LiveKit code and doesn't touch werift or
`@livekit/rtc-node` at all — but it reproduced most reliably in exactly the
scenario that also triggers LiveKit escalation (a crowded area), which
made it look LiveKit-related at first. See `docs/field-notes.md`'s werift
section and issue #29 for the full writeup; noted here only so a future
LiveKit-area crash isn't automatically assumed to be this document's
territory.
