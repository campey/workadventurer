# Android field notes

What we learn building the Android client, per gate. The design is a hypothesis;
anything here that contradicts it means the spec gets revised first.

## Toolchain

- **JDK 17 (Temurin) from a tarball in `~/.jdks`, not the brew cask.** The cask's
  `.pkg` installer needs `sudo` with a TTY, which `!` commands in Claude Code
  don't have. Android Studio's bundled JBR is JDK 25, too new for Gradle 8.10 /
  Kotlin 2.0 / AGP 8.7. Run Gradle with `JAVA_HOME` pointed at the 17 JDK.
- The Gradle wrapper was generated from a one-off Gradle 8.10.2 download (avoids
  `brew install gradle`, which pulls a from-source `openjdk` on macOS 14).

## G0

- **Wire does not bundle `google/protobuf/field_mask.proto`.** It resolves
  `wrappers` and `struct` but fails on `FieldMask`
  (`unable to find google/protobuf/field_mask.proto`, from
  `UpdateSpaceUserMessage.updateMask`). Fixed by vendoring a minimal
  `field_mask.proto` into `protocol/src/wire-extra/` as an extra Wire source dir.
  `proto/` itself is untouched.
- **Prod moved to v1.34.0 and rejects the 1.33 `apiVersionHash`es.** First live run
  (2026-10-05, hash `05489a87`): login, `/map`, spawn and the websocket upgrade
  (token as `Sec-WebSocket-Protocol`, `Origin` header) all worked, then the server
  sent `errorScreenMessage` "Please refresh / A new version of WorkAdventure is
  available". `play.workadventu.re/` reports `v1.34.0`. Hash for that tag, from
  `node scripts/vendor-proto.mjs --check v1.34.0` (read-only): **`23c8eb8c`**.
  Re-run with that hash: joined as a normal player, saw the others, in-area
  detection worked. So the **1.33 proto still decodes against a 1.34.0 server**;
  the hash was the only blocker. The Android default is now `23c8eb8c`
  (`Wa133.API_VERSION_HASHES[0]`, old hashes kept); `--api-version` / 
  `RoomConfig.apiVersionHash` override it to probe a build with no adapter.
  **Not verified:** that the Node CLI fails the same way on prod (same mechanism,
  so very likely: its wa-1.33 adapter sends `05489a87`). It needs a proper
  `wa-1.34` adapter / vendored proto. That's repo-wide adapter work, deliberately
  not done here.
- OkHttp passes a manually set `Sec-WebSocket-Protocol` header through unchanged
  and doesn't require the server to echo it: the risk flagged in the plan didn't
  materialise.
- The vendored proto has no `package` line; `protoWithPackage` copies it with
  `package app.workadventurer.proto;` injected. Wire codegen and a round-trip of
  `ClientToServerMessage.joinRoomFrontMessage` verified.
