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

- `android/docs/field-notes.md` — the Android client's gate-by-gate findings, led by a
  "Protocol and behaviour reference" (spaces, roles, mic state and mute, libwebrtc
  quirks, maps, server versions) with each fact tagged live / code / guess.
- `docs/real-world-test-log.md` (calls with other people) and
  `docs/experimental-test-log.md` (solo tests) — history of real test calls; the
  Android app writes a log file per call (see "Call logs" in the Android notes) and
  `android/tools/call-log-summary.mjs` summarises it.

Read the relevant doc before touching `src/wa-audio.mjs` or anything
LiveKit/werift-related — several of the bugs documented there look
plausible-but-wrong on first read of the code, and were only resolved by
live testing against a real peer.

## Issues, PRs and the project board

Work is tracked on the "workadventurer board" (github.com/users/campey/projects/1;
Status: Todo / In Progress / Done).

- **Starting an issue marks it In Progress.** As soon as you begin work on an
  issue, run `scripts/board-status.sh <issue-number>` (it adds the issue to the
  board if needed). Closing an issue moves it to Done on its own, and new issues
  land in Todo; starting work is the one manual step. Needs the `project` token
  scope (`gh auth refresh -h github.com -s project`).
- **PR bodies link their issue with a closing keyword.** Use `Closes #N` (or
  `Fixes #N`) for each issue the PR completes. `Refs #N`, "Toward #N" or a bare
  `#N` only leaves a mention: the issue's "Linked pull requests" stays empty
  and the board doesn't show the PR. Use `Refs` only when the PR genuinely
  leaves the issue open. (Works on a merged PR too: edit the body. But the
  board's built-in "pull request linked → In Progress" rule fires on any new
  link, so retro-linking a PR to an already-closed issue flips it from Done
  to In Progress. Reset it afterwards: `scripts/board-status.sh <n> done`.)

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
