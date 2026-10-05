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

## G1 — real phone (Galaxy S25 Ultra `SM-S938B`, Android 16 / One UI), 2026-10-05

**Verdict: passed with caveats. Presence survived a locked-screen run on a real
phone, but the run was shorter than the 10 minutes in the spec and the evidence
for "list stayed current" is the user's report, not a measurement.**

- **Measured (adb):** the foreground service ran `21:36:50` → `21:43:20`
  (6 min 30 s, from the OS's FGS state log); it ended with notification-removal
  reason 8 (cancelled by the app), matching the user tapping **Leave** at the
  end. The app process stayed alive throughout (same pid), standby bucket was
  ACTIVE (10), and the crash buffer and main log had **no** FATAL / ANR / kill
  lines for the package.
- **Reported by the user:** "that seemed to work" — presence held while the
  phone was locked. Not independently measured.
- **Not captured:** the exact screen-lock duration (the screen was `Dozing` when
  I looked afterwards), whether any silent reconnect happened (the app doesn't
  log them yet; a `Reconnecting` status would only be seen by someone looking),
  the real permission prompts and what the user saw, and whether OkHttp's 20 s
  `pingInterval` mattered. A longer soak is still worth doing (G2 usage will
  provide one).
- **Bug found by this run: a stale notification stayed after Leave.** For at
  least ~7 minutes after the foreground notification was cancelled (until
  `21:50:44`, when I looked) a notification record remained posted with
  `flags=ONGOING_EVENT` and **without** `FOREGROUND_SERVICE`, i.e. something
  posted it after the service stopped. Cause (evidence-backed hypothesis, not
  reproduced under a debugger): `Leave` sets the state to `Disconnected`
  immediately and `stopSelf()` follows, but the observer coroutine on another
  thread can still call `notify()` after the system has removed the foreground
  notification; cancelling its job doesn't wait for a `notify()` in flight.
  Fix: all posting goes through a lock + `active` flag, and `deactivate()` (flag
  off + `cancel(NOTIF_ID)`) runs before `Leave`/`stopForeground`. **Not yet
  verified live** (needs the fixed APK installed and a Leave on the phone).
- **Two text bugs on the same notification**, found in the same dump and fixed
  with a test: `Connected · 1 players` (now `1 player`), and a `Disconnected`
  state rendered as `Connecting…` (now `Not in a room`). Both now live in the
  pure, tested `notificationText()`.

## G1 — emulator

Emulator: Pixel-class AVD `Medium_Phone_API_35` (Android 15), debug APK, 2026-10-05.

- **Works:** join → `Connecting…` → `Connected` in about 8–10 s on the emulator
  (login + `/map` + `.wam` + websocket), 3 players and 20 areas listed, no crash,
  no `SecurityException`. `PresenceService` runs as `isForeground=true`,
  `types=0x80` (`microphone`) on API 35. Notification has the Leave action; Leave
  from the UI sets `Not in a room` and stops the service and notification.
- **Doze (forced, `dumpsys battery unplug` + `deviceidle force-idle`, state read
  back as `IDLE`):** with the app backgrounded, a stand-in avatar joined (list
  went 3 → 4) and left (4 → 3); status stayed `Connected`. So the websocket kept
  delivering room events under forced deep Doze, and a backgrounded activity
  being recreated didn't touch the session (the process and service live
  independently of the activity).
- **Caveats (what this does NOT prove):** forced Doze via `dumpsys` doesn't
  reproduce a real device's network restrictions or OEM battery managers; the
  permissions were pre-granted with `adb shell pm grant` so the real permission
  flow (and its denial path) is untested; no 10-minute screen-locked run; I did
  not capture whether a silent reconnect happened (status would have shown
  `Reconnecting`, and I only sampled it at a few points); whether OkHttp's
  20 s `pingInterval` is needed is unmeasured.
- **Launch command in the plan was wrong:** `am start -n app.workadventurer/.MainActivity`
  expands against the `applicationId`, but the class lives under the `namespace`
  (`app.workadventurer.app`). Use `app.workadventurer/app.workadventurer.app.MainActivity`.
- **Emulator AVD is `Medium_Phone_API_35`**, not `Medium_Phone` (`emulator -list-avds`).
- **`adb shell input text` dropped characters:** typed `android-client-spec-emu`,
  the field held `and`, so the avatar joined the real room briefly as **`and`**
  instead of a worktree-derived name (a hygiene miss; it left cleanly). Probably
  `input text` racing Compose recomposition, but **unverified**: the real-phone
  run (real typing) will show if it's an app bug.
- **A system dialog ("Messages isn't responding", the emulator's own Google
  Messages app) pushed our activity to the background twice** while the device
  was force-idled. Not our app; the process and service survived both times.

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
