# CLAUDE.md

Project-specific rules for Claude Code sessions working in this repo.

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

## Multi-session / worktree hygiene

Several Claude Code sessions — this one and peers — routinely work in this
repo concurrently, each usually isolated in its own git worktree
(`.claude/worktrees/<name>/`, via the `EnterWorktree` tool /
`superpowers:using-git-worktrees`). Ad-hoc testing without a convention has
already caused real collisions: multiple daemons and improvised avatar names
fighting over the same port/identity.

Rules for spinning up a `wa` daemon / avatar for manual testing:

- **Avatar name**: if you're testing from a worktree (not the primary `main`
  checkout), name the avatar after the worktree/branch —
  `wa join --name <worktree-name>` — not the default `claude`. Reserve the
  bare `claude` name for the primary checkout on `main`.
- **Daemon port**: a daemon started from a worktree must use its own port
  (`--port` / `WA_DAEMON_PORT`) — never the shared default `8787`, which is
  reserved for the primary checkout's daemon. Check what's already listening
  first: `lsof -iTCP -sTCP:LISTEN -P | grep node`.
- **Addressing it**: once more than one daemon is running, a bare `wa status` /
  `wa leave` refuses and lists them — always pass `--port` (or set
  `WA_DAEMON_PORT`) for your worktree's daemon. Its log is
  `~/.workadventurer/daemon-<port>.log`.
- **Clean up**: `wa leave` (or kill the process) when done testing. Don't
  leave test daemons or avatars running past the task that needed them.
