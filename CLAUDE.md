# CLAUDE.md

Instructions for Claude Code sessions working in this repo.

## Docs

- `docs/field-notes.md` — hard-won knowledge from reverse-engineering and
  operating this client: failure modes, non-obvious mechanics, things that
  will bite a future session.
- `docs/livekit.md` — everything learned building and debugging the LiveKit
  transport (issue #8): transport model, publish-path bugs and fixes,
  WEBRTC codec negotiation against real browser peers, the subscribe path's
  known gotcha for whoever builds it next.

Read the relevant doc before touching `src/wa-audio.mjs` or anything
LiveKit/werift-related — several of the bugs documented there look
plausible-but-wrong on first read of the code, and were only resolved by
live testing against a real peer.
