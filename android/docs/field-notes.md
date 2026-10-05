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
- The vendored proto has no `package` line; `protoWithPackage` copies it with
  `package app.workadventurer.proto;` injected. Wire codegen and a round-trip of
  `ClientToServerMessage.joinRoomFrontMessage` verified.
