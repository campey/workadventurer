# CLAUDE.md (android/)

Rules for Claude Code sessions working on the Android client. The repo-root
`CLAUDE.md` also applies. Design: `../docs/superpowers/specs/2026-10-05-android-client-design.md`.

## Isolation and graduation

- This client is prototyped in `android/` in this repo. **Nothing in `android/`
  references the repo outside `android/`, except Gradle reading `../proto/`.**
  No reaching into `src/`.
- **Graduation:** once G4 passes, move to its own `workadventure-app` repo
  (`git filter-repo` on `android/`). Shared protocol assets (`proto/`, adapter
  version hashes, wire-behaviour field notes) then move to a shared core repo
  consumed by both the CLI and the app.

## Hygiene (from the repo CLAUDE.md, as it applies here)

- Any live avatar you spin up for testing is named after the worktree/branch
  (`--name <worktree-name>`), never the bare `claude`.
- A Node `wa` daemon used as the browser-side stand-in uses its own port
  (`--port` / `WA_DAEMON_PORT`), never the shared default `8787`. Check first:
  `lsof -iTCP -sTCP:LISTEN -P | grep node`.
- Clean up when done: `wa leave` (or kill the process), stop the emulator.

## Before voice work

Read `../docs/field-notes.md` and `../docs/livekit.md` before G3/G4: several
bugs documented there look plausible-but-wrong on first read and were only
resolved by live testing against a real peer.

## Toolchain

JDK 17 (Temurin) and the Gradle wrapper. Wire/proto3 and wire-behaviour proofs
are **live checks**, not unit tests. Findings per gate go in `docs/field-notes.md`.
