# Android G3 voice, milestone 3: the microphone, mute, and the red-mic fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user chose native execution) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the phone speaks into the bubble: a real microphone track on every link, a mute that works and is announced to peers, mic state shown correctly (no red mic), controllable from the app and the notification, and applied again after a reconnect.

**Architecture:** `:protocol` gains mic-state announcements (`setMicOn`, with the Node client's re-announce schedule). `:voice` owns one shared local audio track (hardware echo cancellation) added to every link, answerer and offerer, plus `VoiceEngine.setMuted`. `:app` gains a `SetMuted` command and `muted` state (default **muted**), a `VoiceHandle` returned by the voice host so the session can mute it, and the UI/notification controls.

**Tech Stack:** as the G3 M1/M2 plan (`livekit.org.webrtc`, Wire protobuf, kotlinx.coroutines), plus `androidx.test:rules` for the on-device audio test.

**Spec:** `docs/superpowers/specs/2026-10-06-android-g3-voice-design.md` (milestone 3). Read `docs/field-notes.md` "#10 the red mic" and `android/docs/field-notes.md` "G3" sections first.

## Global Constraints

- Mic-state announcement values (wa-1.33/1.34 adapter): `UpdateSpaceUserMessage{spaceName, user{spaceUserId, microphoneState}, updateMask: FieldMask(paths = ["microphoneState"])}`, announced at 0 ms, 1,000 ms and 3,000 ms after joining a space *while the mic is on*, and again when `initSpaceUsersMessage` arrives for a space we are in (the server has registered us). `micOn` is the single source of truth: no code path hard-codes `true`.
- Do NOT add a keepalive audio stream or silence priming: a live microphone track sends RTP continuously (`docs/field-notes.md`: a continuous keepalive OOMs the Node daemon). Stay with the real mic.
- The phone starts **muted** every time it joins (`SessionState.muted = true`, reset by Leave). A reconnect keeps the current mute choice.
- One local audio track, shared by every link; mute = `track.setEnabled(false)` plus `JavaAudioDeviceModule.setMicrophoneMute(true)`.
- Never log or display a player's uuid or a space-user id.
- Live avatar name `g3-voice`. Run Gradle from `android/` with `JAVA_HOME=~/.jdks/jdk-17.0.20.1+1/Contents/Home`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Plain merge commit, never squash.

## Review Focus

1. A mic-state announcement must never fire for a space we have left or never joined, and pending re-announcements must stop when we leave (Task 1).
2. Muting must announce `microphoneState=false` immediately and cancel pending "on" re-announcements, so a late timer cannot re-claim mic-on after a mute (Task 1).
3. After a reconnect the mute choice must be re-applied to the new connection and new voice handle; a fresh join starts muted (Task 2).
4. Mute pressed before the voice engine exists (just after joining) must still take effect when the engine is ready (Task 4).
5. Unmuting while not Connected must be harmless (Task 2).

---

### Task 1: Mic-state announcements in `:protocol`

**Files:**
- Modify: `android/protocol/src/main/kotlin/app/workadventurer/protocol/PusherConnection.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/PusherConnectionTest.kt`

**Interfaces:**
- Consumes: `RoomState.spaces` (space name to our space-user id), `joinSpace`/`leaveSpace`, `scope`, `send`.
- Produces: constructor parameter `micReannounceMs: List<Long> = listOf(0L, 1_000L, 3_000L)` (last, after `cacheDir`); `open fun setMicOn(on: Boolean)`; `val micOn: Boolean`.

- [ ] **Step 1: Write the failing tests** (append inside `PusherConnectionTest`, after `spaceFake`)

```kotlin
    /** Every updateSpaceUserMessage the client sent within [windowMs], as (spaceName, spaceUserId, microphoneState, maskPaths). */
    private fun micUpdates(live: LiveFake, windowMs: Long = 600): List<List<Any?>> =
        generateSequence { live.fake.received.poll(windowMs, TimeUnit.MILLISECONDS) }
            .mapNotNull { it.updateSpaceUserMessage }
            .map { listOf(it.spaceName, it.user?.spaceUserId, it.user?.microphoneState, it.updateMask?.paths) }.toList()

    private suspend fun joined(live: LiveFake, conn: PusherConnection, space: String = "sp") {
        live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = space)))
        waitFor { conn.state.spaces.value.containsKey(space) }
    }

    @Test
    fun turningTheMicOnInASpaceAnnouncesItAtOnceWithTheRightMask() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, micReannounceMs = listOf(0L, 100L, 300L))
            withTimeout(5_000) { conn.connect() }
            joined(live, conn)
            conn.setMicOn(true)
            val sent = micUpdates(live, 800)
            assertEquals(listOf("sp", "sp_7", true, listOf("microphoneState")), sent.first())
            assertEquals(3, sent.count { it[2] == true }, "0, 100 and 300 ms announcements: $sent")
            conn.close()
        }
    }

    @Test
    fun joiningASpaceWhileTheMicIsOnAnnouncesAndWhileOffDoesNot() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, micReannounceMs = listOf(0L, 100L))
            withTimeout(5_000) { conn.connect() }
            joined(live, conn, "off")
            assertTrue(micUpdates(live, 500).isEmpty(), "announced while the mic was off")
            conn.setMicOn(true); micUpdates(live, 400)
            joined(live, conn, "on")
            val sent = micUpdates(live, 600)
            assertEquals(listOf("on", "on"), sent.filter { it[0] == "on" }.map { it[0] }, "announced at join and once more: $sent")
            conn.close()
        }
    }

    // Review Focus 2
    @Test
    fun mutingAnnouncesOffAtOnceAndStopsPendingOnAnnouncements() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, micReannounceMs = listOf(0L, 400L, 800L))
            withTimeout(5_000) { conn.connect() }
            joined(live, conn)
            conn.setMicOn(true)
            delay(100)
            conn.setMicOn(false)
            val sent = micUpdates(live, 1_500)
            assertEquals(false, sent.last()[2], "the last word must be mic-off: $sent")
            assertEquals(1, sent.count { it[2] == true }, "an 'on' timer fired after the mute: $sent")
            conn.close()
        }
    }

    // Review Focus 1
    @Test
    fun leavingASpaceStopsItsAnnouncementsAndAnUnknownSpaceIsNeverAnnounced() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, micReannounceMs = listOf(0L, 400L, 800L))
            withTimeout(5_000) { conn.connect() }
            joined(live, conn)
            conn.setMicOn(true)
            delay(100)
            live.push(ServerToClientMessage(leaveSpaceRequestMessage = LeaveSpaceRequestMessage(spaceName = "sp")))
            waitFor { conn.state.spaces.value.isEmpty() }
            val sent = micUpdates(live, 1_500)
            assertEquals(1, sent.count { it[0] == "sp" }, "announced after leaving: $sent")
            conn.setMicOn(false); conn.setMicOn(true) // no spaces now: nothing to announce
            assertTrue(micUpdates(live, 400).isEmpty())
            conn.close()
        }
    }

    @Test
    fun theServersSpaceUserListReannouncesWhileTheMicIsOn() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, micReannounceMs = listOf(0L))
            withTimeout(5_000) { conn.connect() }
            joined(live, conn)
            conn.setMicOn(true); micUpdates(live, 300)
            live.push(batch(SubMessage(initSpaceUsersMessage = app.workadventurer.proto.InitSpaceUsersMessage(spaceName = "sp"))))
            assertEquals(1, micUpdates(live, 600).count { it[2] == true })
            conn.setMicOn(false); micUpdates(live, 300)
            live.push(batch(SubMessage(initSpaceUsersMessage = app.workadventurer.proto.InitSpaceUsersMessage(spaceName = "sp"))))
            assertTrue(micUpdates(live, 400).isEmpty(), "re-announced while the mic was off")
            conn.close()
        }
    }
```

- [ ] **Step 2: Run to verify RED**

Run: `cd android && ./gradlew --no-daemon :protocol:test --tests '*PusherConnectionTest*'`
Expected: compile FAIL (`micReannounceMs` / `setMicOn` unresolved).

- [ ] **Step 3: Implement.** In `PusherConnection`'s constructor add `private val micReannounceMs: List<Long> = listOf(0L, 1_000L, 3_000L),` as the last parameter. Add imports `app.workadventurer.proto.UpdateSpaceUserMessage`, `app.workadventurer.proto.SpaceUser`, `com.google.protobuf.FieldMask`, `kotlinx.coroutines.Job` (already imported). Add:

```kotlin
    @Volatile var micOn = false
        private set
    private val micTimers = ConcurrentHashMap<String, Job>()

    /** Tell every space we are in whether our mic is live; while it is on, repeat the announcement (see [micReannounceMs]). */
    open fun setMicOn(on: Boolean) {
        micOn = on
        for (space in state.spaces.value.keys) if (on) scheduleMicAnnouncements(space) else { cancelMicTimer(space); announceMic(space) }
    }

    private fun announceMic(spaceName: String) {
        val mine = state.spaces.value[spaceName] ?: return // never joined, or already left
        send(ClientToServerMessage(updateSpaceUserMessage = UpdateSpaceUserMessage(
            spaceName = spaceName,
            user = SpaceUser(spaceUserId = mine, microphoneState = micOn),
            updateMask = FieldMask(paths = listOf("microphoneState")),
        )))
    }

    // A single announcement right after joining races the server registering us and the peers watching us; if it is missed
    // they treat us as muted and never play our audio (issue #10). So repeat it, but only while the mic is on.
    private fun scheduleMicAnnouncements(spaceName: String) {
        micTimers.remove(spaceName)?.cancel()
        micTimers[spaceName] = scope.launch {
            var last = 0L
            for (at in micReannounceMs) {
                delay(at - last); last = at
                if (!micOn || !state.spaces.value.containsKey(spaceName)) return@launch
                announceMic(spaceName)
            }
        }
    }

    private fun cancelMicTimer(spaceName: String) { micTimers.remove(spaceName)?.cancel() }
```

In `joinSpace`, after `_log.tryEmit("joined space $spaceName")` add `if (micOn) scheduleMicAnnouncements(spaceName)`. In `leaveSpace`, right after `state.removeSpace(spaceName)` add `cancelMicTimer(spaceName)`. In `handle`'s batch loop, after `state.applySub(sub)` add:

```kotlin
                    sub.initSpaceUsersMessage?.let { if (micOn && state.spaces.value.containsKey(it.spaceName)) announceMic(it.spaceName) }
```

- [ ] **Step 4: Run to verify GREEN**

Run: `cd android && ./gradlew --no-daemon :protocol:test`
Expected: PASS (all protocol tests).

- [ ] **Step 5: Commit**

```bash
git add android/protocol && git commit -m "feat(android): announce mic state to spaces (the red-mic fix) with the Node client's schedule

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Mute state and command in `WaSession`

**Files:**
- Modify: `android/app/src/main/kotlin/app/workadventurer/app/session/WaSession.kt`, `android/app/src/main/kotlin/app/workadventurer/app/ui/PresenceFormat.kt`
- Test: `android/app/src/test/kotlin/app/workadventurer/app/session/WaSessionTest.kt`, `android/app/src/test/kotlin/app/workadventurer/app/ui/PresenceFormatTest.kt`

**Interfaces:**
- Consumes: Task 1 `PusherConnection.setMicOn`.
- Produces: `interface VoiceHandle : AutoCloseable { fun setMuted(muted: Boolean) }`; `typealias VoiceHost = (PusherConnection) -> VoiceHandle` (replaces the `AutoCloseable` version); `Command.SetMuted(val muted: Boolean)`; `SessionState.muted: Boolean = true`; `micText(muted: Boolean): String` in `PresenceFormat.kt`; `notificationText` appends the mic state.

- [ ] **Step 1: Write the failing tests.** In `WaSessionTest`, `FakeConn` gains `val micCalls = mutableListOf<Boolean>()` and `override fun setMicOn(on: Boolean) { micCalls += on }` (add to the class body next to the other overrides). Add a fake handle at the top of the class and update the three existing voice-host tests to return it:

```kotlin
    private class FakeVoice : VoiceHandle {
        val muteCalls = mutableListOf<Boolean>(); var closed = 0
        override fun setMuted(muted: Boolean) { muteCalls += muted }
        override fun close() { closed++ }
    }
```

Replace the three existing voice tests' `voiceHost = { ... AutoCloseable { ... } }` with `FakeVoice` equivalents (`voiceHost = { c -> started += c; FakeVoice().also { v -> voices += v } }` and assert on `voices[0].closed`), then append:

```kotlin
    @Test
    fun aFreshSessionIsMutedAndTheVoiceStartsMuted() = runTest {
        val voices = mutableListOf<FakeVoice>(); var conn: FakeConn? = null
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { conn = it } }, nowMs = { testScheduler.currentTime },
            voiceHost = { FakeVoice().also { voices += it } })
        assertTrue(session.state.value.muted)
        session.dispatch(Command.Join(cfg)); runCurrent()
        assertTrue(session.state.value.muted)
        assertEquals(listOf(true), voices[0].muteCalls)
        assertEquals(listOf(false), conn!!.micCalls) // mic off on the connection too
    }

    @Test
    fun unmutingTurnsTheMicOnForTheConnectionAndTheVoiceAndMutingTurnsItOff() = runTest {
        val voices = mutableListOf<FakeVoice>(); var conn: FakeConn? = null
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { conn = it } }, nowMs = { testScheduler.currentTime },
            voiceHost = { FakeVoice().also { voices += it } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.SetMuted(false)); runCurrent()
        assertEquals(false, session.state.value.muted)
        assertEquals(false, voices[0].muteCalls.last()); assertEquals(true, conn!!.micCalls.last())
        session.dispatch(Command.SetMuted(true)); runCurrent()
        assertEquals(true, session.state.value.muted)
        assertEquals(true, voices[0].muteCalls.last()); assertEquals(false, conn!!.micCalls.last())
    }

    // Review Focus 3
    @Test
    fun theMuteChoiceSurvivesAReconnectAndALeaveResetsIt() = runTest {
        val voices = mutableListOf<FakeVoice>(); val conns = mutableListOf<FakeConn>()
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { conns += it } }, nowMs = { testScheduler.currentTime },
            voiceHost = { FakeVoice().also { voices += it } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.SetMuted(false)); runCurrent()
        conns[0].fakeClosed.complete(Closed(1006, "net")); runCurrent()
        advanceTimeBy(1_001); runCurrent()
        assertEquals(2, conns.size)
        assertEquals(false, session.state.value.muted)
        assertEquals(false, voices[1].muteCalls.last(), "the new voice handle must be unmuted")
        assertEquals(true, conns[1].micCalls.last())
        session.dispatch(Command.Leave); runCurrent()
        assertTrue(session.state.value.muted)
        session.dispatch(Command.Join(cfg)); runCurrent()
        assertEquals(true, voices.last().muteCalls.last(), "a fresh join starts muted")
    }

    // Review Focus 5
    @Test
    fun unmutingBeforeConnectedIsRememberedNotAppliedToNothing() = runTest {
        val voices = mutableListOf<FakeVoice>()
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { } }, nowMs = { testScheduler.currentTime },
            voiceHost = { FakeVoice().also { voices += it } })
        session.dispatch(Command.SetMuted(false)); runCurrent() // not joined: nothing to apply it to, and no crash
        assertTrue(voices.isEmpty())
        session.dispatch(Command.Join(cfg)); runCurrent()
        assertEquals(true, voices[0].muteCalls.last(), "an unmute pressed before joining must not carry into the join: it starts muted")
    }
```

In `PresenceFormatTest` add:

```kotlin
    @Test
    fun theMicStateReadsPlainlyAndIsPartOfTheNotificationText() {
        assertEquals("Microphone muted", micText(true)); assertEquals("Microphone on", micText(false))
        val s = SessionState(connection = Connection.Connected, players = emptyList(), muted = false)
        assertEquals("Connected · 0 players · mic on", notificationText(s))
        assertEquals("Connected · 0 players · mic muted", notificationText(s.copy(muted = true)))
    }
```

- [ ] **Step 2: Run to verify RED**

Run: `cd android && ./gradlew --no-daemon :app:testDebugUnitTest`
Expected: compile FAIL (`VoiceHandle`, `muted`, `SetMuted`, `micText` unresolved).

- [ ] **Step 3: Implement.** In `WaSession.kt`: add `interface VoiceHandle : AutoCloseable { fun setMuted(muted: Boolean) }`; change `typealias VoiceHost = (PusherConnection) -> VoiceHandle` and the default to `{ object : VoiceHandle { override fun setMuted(muted: Boolean) {}; override fun close() {} } }`; add `data class SetMuted(val muted: Boolean) : Command` to `Command`; add `val muted: Boolean = true` to `SessionState`; add `private var voiceHandle: VoiceHandle? = null` (guarded by `lock`). In `dispatch`:

```kotlin
                is Command.SetMuted -> {
                    _state.update { it.copy(muted = cmd.muted) }
                    if (_state.value.connection == Connection.Connected) applyMute(cmd.muted)
                }
```

with `/** Caller holds [lock]. */ private fun applyMute(muted: Boolean) { conn?.setMicOn(!muted); voiceHandle?.setMuted(muted) }`. In `run`, replace the `voice` handling:

```kotlin
                val handle = try { voiceHost(c) } catch (e: Exception) { null }
                voice = handle
                synchronized(lock) { if (gen == generation) { voiceHandle = handle; applyMute(_state.value.muted) } }
```

and in the `finally` block before closing: `synchronized(lock) { if (voiceHandle === voice) voiceHandle = null }`. `Leave` already resets `_state.value = SessionState()` (muted defaults to true). In `PresenceFormat.kt`: `fun micText(muted: Boolean) = if (muted) "Microphone muted" else "Microphone on"` and `notificationText`'s Connected branch becomes `"Connected · ${n} ${players} · mic ${if (s.muted) "muted" else "on"}"`.

- [ ] **Step 4: Run to verify GREEN**

Run: `cd android && ./gradlew --no-daemon :app:testDebugUnitTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app && git commit -m "feat(android): mute state and command, applied to the connection and the voice handle

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Microphone in `:voice`, checked on the phone

**Files:**
- Modify: `android/voice/src/main/kotlin/app/workadventurer/voice/VoiceEngine.kt`, `.../WebRtcPeerLink.kt`, `android/voice/build.gradle.kts`, `android/gradle/libs.versions.toml`
- Test: `android/voice/src/androidTest/kotlin/app/workadventurer/voice/OfferAnswerLoopbackTest.kt`

**Interfaces:**
- Consumes: `PeerLink`, `WebRtcPeerLink`, `VoiceEngine` (M1/M2).
- Produces: `VoiceEngine.setMuted(muted: Boolean)` (engine starts muted); `WebRtcPeerLink` takes `localTrack: AudioTrack` and adds it before every offer/answer; `internal suspend fun WebRtcPeerLink.audioPacketsSent(): Long` and `audioPacketsReceived(): Long`.

- [ ] **Step 1: Write the failing test** (add to `OfferAnswerLoopbackTest`; add `androidTestImplementation(libs.androidx.test.rules)` with `androidx-test-rules = { module = "androidx.test:rules", version = "1.6.1" }` in the catalog, and a `@get:Rule val mic = GrantPermissionRule.grant(android.Manifest.permission.RECORD_AUDIO)`)

```kotlin
    // M3: with the mic unmuted, real audio packets flow in both directions between our own offerer and answerer, and muted
    // flips the engine without crashing. (The red-mic fix relies on RTP flowing continuously from a live track.)
    @Test
    fun anUnmutedMicSendsAudioPacketsBothWays() = runBlocking {
        val engine = VoiceEngine(InstrumentationRegistry.getInstrumentation().targetContext)
        try {
            engine.setMuted(false)
            val ice = listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null))
            val offerer = engine.newLink("c1", ice) as WebRtcPeerLink
            val answerer = engine.newLink("c1", ice) as WebRtcPeerLink
            val offer = withTimeout(15_000) { offerer.createOffer() }!!
            assertTrue("a=sendrecv" in offer || "a=sendonly" in offer, "the offer must carry our audio track, not be receive-only")
            val answer = withTimeout(15_000) { answerer.acceptOffer(offer) }!!
            offerer.acceptAnswer(answer)
            assertTrue(offerer.awaitConnected(15_000) && answerer.awaitConnected(15_000))
            kotlinx.coroutines.delay(2_500)
            assertTrue(offerer.audioPacketsSent() > 30, "offerer sent ${offerer.audioPacketsSent()} packets")
            assertTrue(answerer.audioPacketsReceived() > 30, "answerer received ${answerer.audioPacketsReceived()} packets")
            assertTrue(answerer.audioPacketsSent() > 30, "answerer sent ${answerer.audioPacketsSent()} packets")
            assertTrue(offerer.audioPacketsReceived() > 30, "offerer received ${offerer.audioPacketsReceived()} packets")
            engine.setMuted(true); engine.setMuted(false)
            offerer.close(); answerer.close()
        } finally { engine.close() }
    }
```

- [ ] **Step 2: Run to verify RED**

Run (phone connected and unlocked): `cd android && ./gradlew --no-daemon :voice:connectedDebugAndroidTest`
Expected: compile FAIL (`setMuted`, `audioPacketsSent` unresolved).

- [ ] **Step 3: Implement.** `VoiceEngine`: keep the `JavaAudioDeviceModule` in a field `private val adm`, remove the early `audio.release()`; create `private val micSource = factory.createAudioSource(MediaConstraints())` and `internal val micTrack = factory.createAudioTrack("wa-mic", micSource)`; start muted: `micTrack.setEnabled(false); adm.setMicrophoneMute(true)`; add

```kotlin
    /** Mute stops our microphone reaching peers (the track sends silence) and mutes the capture itself. */
    fun setMuted(muted: Boolean) { micTrack.setEnabled(!muted); adm.setMicrophoneMute(muted) }
```

In `close()` dispose in order: `micTrack.dispose(); micSource.dispose(); factory.dispose(); adm.release()`. `newLink` passes `micTrack` to `WebRtcPeerLink`. `WebRtcPeerLink` constructor gains `private val localTrack: livekit.org.webrtc.AudioTrack`; in `createOffer` replace the `addTransceiver(... RECV_ONLY)` call with `pc.addTrack(localTrack, listOf("wa-voice"))`; in `acceptOffer`, after the video-transceivers-inactive block and before `createAnswer`, add `pc.addTrack(localTrack, listOf("wa-voice"))` (it reuses the receive-only audio transceiver). Add the stats helpers:

```kotlin
    private suspend fun audioStat(kind: String, key: String): Long {
        val out = CompletableDeferred<Long>()
        pc.getStats { report ->
            val v = report.statsMap.values.firstOrNull { it.type == kind && it.members["kind"] == "audio" }?.members?.get(key)
            out.complete((v as? Number)?.toLong() ?: 0L)
        }
        return withTimeoutOrNull(3_000) { out.await() } ?: 0L
    }
    internal suspend fun audioPacketsSent() = audioStat("outbound-rtp", "packetsSent")
    internal suspend fun audioPacketsReceived() = audioStat("inbound-rtp", "packetsReceived")
```

- [ ] **Step 4: Run to verify GREEN on the phone**

Run: `cd android && ./gradlew --no-daemon :voice:connectedDebugAndroidTest` three times.
Expected: PASS each time (including the earlier `AnswerRealBrowserOfferTest` and loopback tests). If packet counts are 0, check that the test APK holds `RECORD_AUDIO` (the rule) and that `setMuted(false)` ran before the link was created.

- [ ] **Step 5: Commit**

```bash
git add android && git commit -m "feat(android): a shared microphone track on every link, with mute

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire mute into the host, the screen and the notification

**Files:**
- Modify: `android/app/src/main/kotlin/app/workadventurer/app/MeshVoiceHost.kt`, `.../ui/PresenceScreen.kt`, `.../PresenceService.kt`
- Test: none new (platform glue, verified live in Task 5); the JVM tests from Task 2 already cover the session side.

**Interfaces:**
- Consumes: `VoiceHandle`, `Command.SetMuted`, `micText`, `VoiceEngine.setMuted`.
- Produces: `MeshVoiceHost` returns a `VoiceHandle`; a Mute/Unmute button; a notification action.

- [ ] **Step 1: `MeshVoiceHost` returns a `VoiceHandle`.** Change the class to `: (PusherConnection) -> VoiceHandle`. Add a private handle class holding `@Volatile var engine: VoiceEngine?` and `@Volatile var muted = true`; `setMuted(m)` stores it and calls `engine?.setMuted(m)`; after `val e = VoiceEngine(context)` assign `handle.engine = e; e.setMuted(handle.muted)` (Review Focus 4: a mute pressed before the engine exists is applied when it appears). `close()` is `scope.cancel()` as before.

- [ ] **Step 2: Screen.** In `PresenceScreen`, when `state.connection == Connection.Connected`, show a button labelled `if (state.muted) "Unmute" else "Mute"` (content description `micText(state.muted)` plus the action) that calls `onCommand(Command.SetMuted(!state.muted))`, and a status line `micText(state.muted)`. Follow the existing button style in that file (48 dp min height, TalkBack content description).

- [ ] **Step 3: Notification action.** In `PresenceService` add `ACTION_TOGGLE_MUTE = "app.workadventurer.action.TOGGLE_MUTE"`; handle it in `onStartCommand` with `session.dispatch(Command.SetMuted(!session.state.value.muted))`; add `.addAction(..., if (state muted) "Unmute" else "Mute", PendingIntent.getService(... ACTION_TOGGLE_MUTE ...))` to the presence notification (the builder receives the current text; pass the muted flag into `notification(text, muted)` and have the observer pass `s.muted`).

- [ ] **Step 4: Build and run everything**

Run: `cd android && ./gradlew --no-daemon test :app:assembleDebug`
Expected: BUILD SUCCESSFUL, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add android && git commit -m "feat(android): Mute/Unmute on the screen and the notification, applied to the voice engine

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Live check M3, speaking to a browser peer

**Files:** `android/docs/field-notes.md`.

- [ ] **Step 1: Install and join.** `./gradlew --no-daemon :app:assembleDebug`, `adb -s R5CY31ENYEH install -r app/build/outputs/apk/debug/app-debug.apk`, start `adb logcat -c; adb logcat -v time -s WaConn:I WaSession:I WaVoice:I AndroidRuntime:E libc:F`, join as `g3-voice` (the UI shows "Microphone muted"), then ask the user (David, browser, mic on) to stand next to the phone's avatar or have the phone walk to them.
Expected: audio from David plays within a few seconds (as in M2), and the phone is shown as muted in the browser.

- [ ] **Step 2: Unmute and speak.** Tap Unmute, ask the user to confirm: (a) they hear the phone, (b) the phone's mic icon in the browser is NOT red, (c) it shows as unmuted. Then Mute: (d) the browser shows it muted and the audio stops. Repeat mute/unmute three times.
Expected: all four confirmed; the log shows no errors.

- [ ] **Step 3: Notification and lock screen.** Lock the screen, unmute from the notification's action, speak; then mute from it.
Expected: works with the screen off.

- [ ] **Step 4: Churn and reconnect.** Walk away and back twice with the phone unmuted (mic state must be re-announced into each new bubble: the browser should show the phone unmuted without any tap); then turn Wi-Fi/airplane mode off and on to force a reconnect and check the mute choice survives.
Expected: unmuted into each new bubble, no red mic; the choice is kept across the reconnect.

- [ ] **Step 5: Leave, record, commit.** Leave the room. Record in `android/docs/field-notes.md` a "G3 M3 live check" section: who heard what, the red-mic result, lock-screen result, reconnect result, any echo/feedback and the Android mic-indicator behaviour while muted. Commit:

```bash
git add android/docs && git commit -m "docs(android): G3 M3 live check, speaking to a browser peer

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
