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

### Running the Gradle build in a Claude Code cloud container

Needs `dl.google.com` allowed in the environment's network settings (plus the default Maven Central and Gradle plugin portal).
Set up once per container (not in the session-start hook: about 600 MB):

1. `apt-get update && apt-get install -y openjdk-17-jdk-headless` (the toolchain wants JDK 17; the image has 21).
2. Android SDK: download `commandlinetools-linux-11076708_latest.zip` from `https://dl.google.com/android/repository/`, unzip it to
   `/opt/android-sdk/cmdline-tools/latest`, then `yes | sdkmanager --licenses` and
   `sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"`.
3. `export ANDROID_HOME=/opt/android-sdk` and `echo "sdk.dir=/opt/android-sdk" > android/local.properties` (git-ignored).
4. `./gradlew testDebugUnitTest :nav:test :protocol:test :wa-cli:test`.

Maven Central answers 429 now and then from the container: rerun, Gradle keeps what it already fetched. Without the Android SDK or
`dl.google.com`, `tools/nav-test-cloud.sh` runs just the pure-JVM `:nav` tests.
