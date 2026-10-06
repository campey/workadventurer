# Android G3 voice, milestones 1 and 2: space join, then hear a browser peer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the phone joins the WorkAdventure space behind a bubble, answers a browser peer's WebRTC offer, and plays its audio, in the background.

**Architecture:** `:protocol` gains query/answer plumbing, space membership and a stream of voice events (all pure JVM, unit-tested). A new `:voice` Android library holds a pure signalling codec and `MeshSession` (unit-tested against a fake link) plus the real libwebrtc `VoiceEngine` and `WebRtcPeerLink` (checked on the phone). `WaSession` gets a `voiceHost` seam; `:app` supplies the real host. Speaking, mute and being the offerer are later milestones (M3, M4).

**Tech Stack:** Kotlin, Wire-generated protobuf (`app.workadventurer.proto`), OkHttp WebSocket, kotlinx.coroutines and serialization-json, `io.github.webrtc-sdk:android-prefixed:144.7559.14` (package `livekit.org.webrtc`).

**Spec:** `docs/superpowers/specs/2026-10-06-android-g3-voice-design.md` (read it, and `docs/field-notes.md` "werift constraints" and `android/docs/field-notes.md` "G3 — voice: library spike").

## Global Constraints

- Audio library is exactly `io.github.webrtc-sdk:android-prefixed:144.7559.14` (already in `android/gradle/libs.versions.toml` as `webrtc`). Never add a second libwebrtc build.
- `voice/src/main/AndroidManifest.xml` keeps `ACCESS_NETWORK_STATE`, `INTERNET`, `MODIFY_AUDIO_SETTINGS`, `RECORD_AUDIO`; without `ACCESS_NETWORK_STATE` the process aborts natively.
- libwebrtc finds no network if gathering starts right after the factory is created: the engine is created at join and links wait at least 1,500 ms after engine creation; an offer or answer with zero candidates is a failure (tear the link down, send nothing).
- Signals are simple-peer JSON `{type: "offer"|"answer", sdp}` / `{type: "candidate", candidate: {...}}`; full non-trickle SDP; wait for ICE gathering at most 4,000 ms.
- Space join values (wa-1.33/1.34 adapter): `filterType = ALL_USERS (0)`, default `propertiesToSync = ["cameraState", "microphoneState", "screenSharingState"]`, then send `addSpaceFilterMessage` (without it the server never sets up peer connections).
- Never log or display a player's uuid or email, nor a space-user id. Log connection ids, space names and counts only.
- This plan does not announce microphone state or send audio (M3), and does not create offers (M4): a `webRtcStart` with `initiator = true` is logged as unsupported and ignored.
- Nothing in `android/` may reference files outside `android/` (except Gradle reading `../proto/`): the real browser offer fixture is *copied* into `android/voice/src/androidTest/assets/`.
- Live avatar name: `g3-voice`. Run Gradle from `android/` with `JAVA_HOME=~/.jdks/jdk-17.0.20.1+1/Contents/Home`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Merge with a plain merge commit, never squash.

## Review Focus

Failure modes the spec implies that are most likely to bite, most likely first; each has a test in the owning task:

1. A signal arriving for a connection we already tore down must be ignored, not resurrect it (Task 7).
2. An answer with zero ICE candidates must close the link and send nothing (Task 7).
3. A peer's disconnect, or leaving the space, closes that peer's/space's links, and a later signal with the same connection id is ignored (Task 7).
4. A duplicate `webRtcStart` for the same connection id must not create a second link (Task 7).
5. Unparseable or unknown signal JSON must never crash the mesh (Tasks 6 and 7).
6. A query the server never answers must time out, and a late answer must not break a later query (Task 1).
7. Leaving a space we never joined, or a join request for a space we are already in, must be harmless (Task 3).

---

## File structure

- `android/protocol/src/main/kotlin/app/workadventurer/protocol/Spaces.kt` (create): `VoiceEvent`, `IceServerInfo`, `QueryFailed`, `DEFAULT_SPACE_PROPS`.
- `android/protocol/.../RoomState.kt` (modify): `spaces`, `spaceUserNames`, reducers.
- `android/protocol/.../PusherConnection.kt` (modify): `query`, space join/leave, `voiceEvents`, `sendSignal`, `iceServers`.
- `android/voice/build.gradle.kts` (modify): serialization plugin, `:protocol`, test deps.
- `android/voice/src/main/kotlin/app/workadventurer/voice/SimplePeerSignal.kt` (create): signal codec.
- `android/voice/src/main/kotlin/app/workadventurer/voice/MeshSession.kt` (create): `PeerLink`, `PeerLinkFactory`, `SignalSink`, `MeshSession`.
- `android/voice/src/main/kotlin/app/workadventurer/voice/VoiceEngine.kt`, `WebRtcPeerLink.kt` (create): libwebrtc.
- `android/voice/src/androidTest/...` and `assets/live-browser-offer-with-video.sdp`: instrumented answer test; delete the throwaway `WebRtcSpikeTest.kt`.
- `android/app/.../session/WaSession.kt` (modify): `voiceHost` seam. `android/app/.../MeshVoiceHost.kt` (create), `WaApp.kt` (modify).

---

### Task 1: Query/answer plumbing

**Files:**
- Modify: `android/protocol/src/main/kotlin/app/workadventurer/protocol/PusherConnection.kt`
- Create: `android/protocol/src/main/kotlin/app/workadventurer/protocol/Spaces.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/PusherConnectionTest.kt`

**Interfaces:**
- Consumes: existing `PusherConnection.send`, `handle`, Wire classes `QueryMessage`, `AnswerMessage`.
- Produces: `class QueryFailed(message: String) : Exception(message)` and `open suspend fun query(timeoutMs: Long = 10_000, build: (id: Int) -> QueryMessage): AnswerMessage` (throws `QueryFailed` on a server error answer, `kotlinx.coroutines.TimeoutCancellationException` on timeout).

- [ ] **Step 1: Write the failing tests** (append inside the class, before its final `}`)

```kotlin
    @Test
    fun aQueryResolvesWithTheAnswerThatCarriesItsId() = runBlocking<Unit> {
        val live = LiveFake { ws, msg ->
            msg.queryMessage?.let { q ->
                ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, joinSpaceAnswer = JoinSpaceAnswer(spaceUserId = "sp_${q.id}")))))
            }
        }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            val a = conn.query { id -> QueryMessage(id = id, joinSpaceQuery = JoinSpaceQuery(spaceName = "a")) }
            val b = conn.query { id -> QueryMessage(id = id, joinSpaceQuery = JoinSpaceQuery(spaceName = "b")) }
            assertNotEquals(a.id, b.id)
            assertEquals("sp_${a.id}", a.joinSpaceAnswer!!.spaceUserId)
            conn.close()
        }
    }

    @Test
    fun aServerErrorAnswerFailsTheQuery() = runBlocking<Unit> {
        val live = LiveFake { ws, msg ->
            msg.queryMessage?.let { q -> ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, error = ErrorMessage(message = "nope"))))) }
        }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            val e = assertFailsWith<QueryFailed> { conn.query { id -> QueryMessage(id = id, iceServersQuery = IceServersQuery()) } }
            assertEquals("nope", e.message)
            conn.close()
        }
    }

    // Review Focus 6: a query nobody answers times out, and its late answer must not disturb the next query.
    @Test
    fun anUnansweredQueryTimesOutAndALateAnswerIsHarmless() = runBlocking<Unit> {
        val seen = java.util.concurrent.atomic.AtomicInteger()
        val live = LiveFake { ws, msg ->
            msg.queryMessage?.let { q ->
                if (seen.incrementAndGet() > 1) ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, joinSpaceAnswer = JoinSpaceAnswer(spaceUserId = "ok")))))
                else Thread { Thread.sleep(500); ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, joinSpaceAnswer = JoinSpaceAnswer(spaceUserId = "late"))))) }.start()
            }
        }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertFailsWith<kotlinx.coroutines.TimeoutCancellationException> {
                conn.query(timeoutMs = 200) { id -> QueryMessage(id = id, joinSpaceQuery = JoinSpaceQuery(spaceName = "x")) }
            }
            delay(700) // the late answer for the first query arrives now
            assertEquals("ok", conn.query { id -> QueryMessage(id = id, joinSpaceQuery = JoinSpaceQuery(spaceName = "y")) }.joinSpaceAnswer!!.spaceUserId)
            conn.close()
        }
    }
```

Add imports to the test file if missing: `app.workadventurer.proto.AnswerMessage`, `ErrorMessage`, `IceServersQuery`, `JoinSpaceAnswer`, `JoinSpaceQuery`, `QueryMessage`, `kotlin.test.assertFailsWith`, `kotlin.test.assertNotEquals`.

- [ ] **Step 2: Run to verify RED**

Run: `cd android && ./gradlew --no-daemon :protocol:test --tests '*PusherConnectionTest*'`
Expected: compile FAIL (`query`/`QueryFailed` unresolved).

- [ ] **Step 3: Implement.** Create `Spaces.kt`:

```kotlin
package app.workadventurer.protocol

/** The server answered a query with an error. */
class QueryFailed(message: String) : Exception(message)
```

In `PusherConnection.kt` add imports `app.workadventurer.proto.AnswerMessage`, `app.workadventurer.proto.QueryMessage`, `kotlinx.coroutines.withTimeout`, `java.util.concurrent.atomic.AtomicInteger`; add near `pendingLocates`:

```kotlin
    private val pendingQueries = ConcurrentHashMap<Int, CompletableDeferred<AnswerMessage>>()
    private val queryIds = AtomicInteger(1)

    /** Send a query and wait for the answer that carries its id. */
    open suspend fun query(timeoutMs: Long = 10_000, build: (id: Int) -> QueryMessage): AnswerMessage {
        val id = queryIds.getAndIncrement()
        val answer = CompletableDeferred<AnswerMessage>()
        pendingQueries[id] = answer
        try {
            send(ClientToServerMessage(queryMessage = build(id)))
            val a = withTimeout(timeoutMs) { answer.await() }
            a.error?.let { throw QueryFailed(it.message) }
            return a
        } finally {
            pendingQueries.remove(id, answer)
        }
    }
```

In `handle`, before the `errorScreenMessage` line, add:

```kotlin
        m.answerMessage?.let { pendingQueries.remove(it.id)?.complete(it); return }
```

- [ ] **Step 4: Run to verify GREEN**

Run: `cd android && ./gradlew --no-daemon :protocol:test`
Expected: all protocol tests PASS (55 + 3).

- [ ] **Step 5: Commit**

```bash
git add android/protocol && git commit -m "feat(android): query/answer plumbing in PusherConnection

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Space state in RoomState

**Files:**
- Modify: `android/protocol/src/main/kotlin/app/workadventurer/protocol/RoomState.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/RoomStateTest.kt`

**Interfaces:**
- Produces: `RoomState.spaces: StateFlow<Map<String, String>>` (space name to our space-user id), `RoomState.spaceUserNames: StateFlow<Map<String, String>>` (space-user id to display name), `fun addSpace(spaceName: String, spaceUserId: String)`, `fun removeSpace(spaceName: String)`; `applySub` handles `initSpaceUsersMessage`, `addSpaceUserMessage`, `updateSpaceUserMessage`, `removeSpaceUserMessage`; `clear()` also clears both.

- [ ] **Step 1: Write the failing tests** (append inside `RoomStateTest`)

```kotlin
    @Test
    fun spaceMembershipIsTrackedAndRemoved() {
        val s = RoomState()
        s.addSpace("open-space", "open-space_7")
        assertEquals(mapOf("open-space" to "open-space_7"), s.spaces.value)
        s.removeSpace("open-space")
        assertEquals(emptyMap(), s.spaces.value)
        s.removeSpace("never-joined") // harmless
    }

    @Test
    fun spaceUserNamesFollowInitAddUpdateAndRemove() {
        val s = RoomState()
        s.applySub(SubMessage(initSpaceUsersMessage = InitSpaceUsersMessage(spaceName = "sp", users = listOf(
            SpaceUser(spaceUserId = "sp_1", name = "Ada"), SpaceUser(spaceUserId = "sp_2", name = "Bob")))))
        assertEquals(mapOf("sp_1" to "Ada", "sp_2" to "Bob"), s.spaceUserNames.value)
        s.applySub(SubMessage(addSpaceUserMessage = AddSpaceUserMessage(spaceName = "sp", user = SpaceUser(spaceUserId = "sp_3", name = "Cy"))))
        s.applySub(SubMessage(updateSpaceUserMessage = UpdateSpaceUserMessage(spaceName = "sp", user = SpaceUser(spaceUserId = "sp_1", name = "Ada L"))))
        s.applySub(SubMessage(updateSpaceUserMessage = UpdateSpaceUserMessage(spaceName = "sp", user = SpaceUser(spaceUserId = "sp_2", name = ""))))  // no name in the update: keep
        s.applySub(SubMessage(removeSpaceUserMessage = RemoveSpaceUserMessage(spaceName = "sp", spaceUserId = "sp_3")))
        assertEquals(mapOf("sp_1" to "Ada L", "sp_2" to "Bob"), s.spaceUserNames.value)
    }

    @Test
    fun clearForgetsSpaces() {
        val s = RoomState()
        s.addSpace("sp", "sp_1")
        s.applySub(SubMessage(addSpaceUserMessage = AddSpaceUserMessage(spaceName = "sp", user = SpaceUser(spaceUserId = "sp_2", name = "Bob"))))
        s.clear()
        assertTrue(s.spaces.value.isEmpty() && s.spaceUserNames.value.isEmpty())
    }
```

Imports: `app.workadventurer.proto.InitSpaceUsersMessage`, `AddSpaceUserMessage`, `UpdateSpaceUserMessage`, `RemoveSpaceUserMessage`, `SpaceUser`, `kotlin.test.assertTrue`.

- [ ] **Step 2: Run to verify RED**

Run: `cd android && ./gradlew --no-daemon :protocol:test --tests '*RoomStateTest*'`
Expected: compile FAIL (`addSpace` unresolved).

- [ ] **Step 3: Implement** in `RoomState.kt`: add imports for `InitSpaceUsersMessage` not needed (accessed via `sub.`). Add fields and functions:

```kotlin
    private val _spaces = MutableStateFlow<Map<String, String>>(emptyMap())
    private val _spaceUserNames = MutableStateFlow<Map<String, String>>(emptyMap())

    /** Spaces we are a member of: space name to our space-user id. */
    val spaces: StateFlow<Map<String, String>> = _spaces.asStateFlow()

    /** Display names of space members, by space-user id. Names only: never a uuid. */
    val spaceUserNames: StateFlow<Map<String, String>> = _spaceUserNames.asStateFlow()

    fun addSpace(spaceName: String, spaceUserId: String) { _spaces.update { it + (spaceName to spaceUserId) } }
    fun removeSpace(spaceName: String) { _spaces.update { it - spaceName } }
```

In `applySub`, append:

```kotlin
        sub.initSpaceUsersMessage?.let { m ->
            _spaceUserNames.update { cur -> cur + m.users.filter { it.name.isNotBlank() }.associate { it.spaceUserId to it.name } }
        }
        (sub.addSpaceUserMessage?.user ?: sub.updateSpaceUserMessage?.user)?.let { u ->
            if (u.name.isNotBlank()) _spaceUserNames.update { it + (u.spaceUserId to u.name) }
        }
        sub.removeSpaceUserMessage?.let { r -> _spaceUserNames.update { it - r.spaceUserId } }
```

In `clear()` add `_spaces.value = emptyMap(); _spaceUserNames.value = emptyMap()`.

- [ ] **Step 4: Run to verify GREEN**

Run: `cd android && ./gradlew --no-daemon :protocol:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/protocol && git commit -m "feat(android): space membership and space-user names in RoomState

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Join and leave a space

**Files:**
- Modify: `android/protocol/.../PusherConnection.kt`, `android/protocol/.../Spaces.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/PusherConnectionTest.kt`

**Interfaces:**
- Consumes: Task 1 `query`, Task 2 `state.addSpace/removeSpace/spaces`.
- Produces: in `Spaces.kt` `val DEFAULT_SPACE_PROPS = listOf("cameraState", "microphoneState", "screenSharingState")`; `PusherConnection` handles server `joinSpaceRequestMessage` (queries `joinSpaceQuery`, records the space, sends `addSpaceFilterMessage`) and `leaveSpaceRequestMessage` (removes it, sends `removeSpaceFilterMessage` and a fire-and-forget `leaveSpaceQuery`).

- [ ] **Step 1: Write the failing tests** (append in `PusherConnectionTest`)

```kotlin
    private fun spaceFake(onLeaveQuery: () -> Unit = {}) = LiveFake { ws, msg ->
        msg.queryMessage?.let { q ->
            when {
                q.joinSpaceQuery != null -> ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, joinSpaceAnswer = JoinSpaceAnswer(spaceUserId = "${q.joinSpaceQuery!!.spaceName}_7")))))
                q.leaveSpaceQuery != null -> onLeaveQuery()
            }
        }
    }

    @Test
    fun aJoinSpaceRequestJoinsWithTheAdapterValuesThenWatchesTheSpace() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "open-space_bubble1")))
            waitFor { conn.state.spaces.value.containsKey("open-space_bubble1") }
            assertEquals("open-space_bubble1_7", conn.state.spaces.value["open-space_bubble1"])
            val sent = generateSequence { live.fake.received.poll(2, TimeUnit.SECONDS) }.take(40).toList()
            val join = sent.mapNotNull { it.queryMessage?.joinSpaceQuery }.single()
            assertEquals(FilterType.ALL_USERS, join.filterType)
            assertEquals(listOf("cameraState", "microphoneState", "screenSharingState"), join.propertiesToSync)
            assertEquals("open-space_bubble1", sent.mapNotNull { it.addSpaceFilterMessage }.single().spaceFilterMessage!!.spaceName)
            conn.close()
        }
    }

    @Test
    fun theServersOwnPropertiesToSyncWinOverTheDefaults() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp", propertiesToSync = listOf("microphoneState"))))
            waitFor { conn.state.spaces.value.containsKey("sp") }
            val join = generateSequence { live.fake.received.poll(2, TimeUnit.SECONDS) }.take(40).mapNotNull { it.queryMessage?.joinSpaceQuery }.first()
            assertEquals(listOf("microphoneState"), join.propertiesToSync)
            conn.close()
        }
    }

    // Review Focus 7: a second join request for a space we are in, and a leave for one we never joined, are harmless.
    @Test
    fun repeatedJoinsAndUnknownLeavesAreHarmless() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp")))
            waitFor { conn.state.spaces.value.containsKey("sp") }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp")))
            live.push(ServerToClientMessage(leaveSpaceRequestMessage = LeaveSpaceRequestMessage(spaceName = "never")))
            delay(300)
            val sent = generateSequence { live.fake.received.poll(300, TimeUnit.MILLISECONDS) }.toList()
            assertEquals(1, sent.count { it.queryMessage?.joinSpaceQuery != null })
            assertEquals(0, sent.count { it.removeSpaceFilterMessage != null })
            assertEquals(setOf("sp"), conn.state.spaces.value.keys)
            conn.close()
        }
    }

    @Test
    fun aLeaveSpaceRequestUnwatchesAndLeaves() = runBlocking<Unit> {
        val left = java.util.concurrent.CountDownLatch(1)
        val live = spaceFake { left.countDown() }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp")))
            waitFor { conn.state.spaces.value.containsKey("sp") }
            live.push(ServerToClientMessage(leaveSpaceRequestMessage = LeaveSpaceRequestMessage(spaceName = "sp")))
            waitFor { conn.state.spaces.value.isEmpty() }
            assertTrue(left.await(3, TimeUnit.SECONDS), "leaveSpaceQuery never sent")
            val sent = generateSequence { live.fake.received.poll(300, TimeUnit.MILLISECONDS) }.toList()
            assertEquals("sp", sent.mapNotNull { it.removeSpaceFilterMessage }.single().spaceFilterMessage!!.spaceName)
            conn.close()
        }
    }
```

Imports: `app.workadventurer.proto.FilterType`, `JoinSpaceRequestMessage`, `LeaveSpaceRequestMessage`.

- [ ] **Step 2: Run to verify RED**

Run: `cd android && ./gradlew --no-daemon :protocol:test --tests '*PusherConnectionTest*'`
Expected: tests FAIL (state never gets the space), not a compile error.

- [ ] **Step 3: Implement.** Append to `Spaces.kt`:

```kotlin
/** What the wa-1.33/1.34 adapter asks to sync when the server doesn't say. */
val DEFAULT_SPACE_PROPS = listOf("cameraState", "microphoneState", "screenSharingState")
```

In `PusherConnection.kt` add imports `AddSpaceFilterMessage`, `FilterType`, `JoinSpaceQuery`, `LeaveSpaceQuery`, `RemoveSpaceFilterMessage`, `SpaceFilterMessage` (all `app.workadventurer.proto`); add:

```kotlin
    private val spaceMutex = kotlinx.coroutines.sync.Mutex()

    private fun joinSpace(spaceName: String, props: List<String>) {
        scope.launch {
            spaceMutex.withLock {
                if (state.spaces.value.containsKey(spaceName)) return@launch // already a member
                try {
                    val answer = query { id ->
                        QueryMessage(id = id, joinSpaceQuery = JoinSpaceQuery(
                            spaceName = spaceName, filterType = FilterType.ALL_USERS,
                            propertiesToSync = props.ifEmpty { DEFAULT_SPACE_PROPS },
                        ))
                    }
                    state.addSpace(spaceName, answer.joinSpaceAnswer?.spaceUserId.orEmpty())
                    // "watch" the space: without this the server never sets up peer connections for us
                    send(ClientToServerMessage(addSpaceFilterMessage = AddSpaceFilterMessage(SpaceFilterMessage(spaceName = spaceName))))
                    _log.tryEmit("joined space $spaceName")
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _log.tryEmit("joinSpace $spaceName failed: ${e.message}")
                }
            }
        }
    }

    private fun leaveSpace(spaceName: String) {
        scope.launch {
            spaceMutex.withLock {
                if (!state.spaces.value.containsKey(spaceName)) return@launch // never joined
                state.removeSpace(spaceName)
                send(ClientToServerMessage(removeSpaceFilterMessage = RemoveSpaceFilterMessage(SpaceFilterMessage(spaceName = spaceName))))
                _log.tryEmit("left space $spaceName")
            }
            // fire and forget: the server cleans up our membership either way
            try { query { id -> QueryMessage(id = id, leaveSpaceQuery = LeaveSpaceQuery(spaceName = spaceName)) } } catch (e: Exception) { /* ignored */ }
        }
    }
```

(import `kotlinx.coroutines.sync.withLock`.) In `handle`, before the `answerMessage` line:

```kotlin
        m.joinSpaceRequestMessage?.let { joinSpace(it.spaceName, it.propertiesToSync); return }
        m.leaveSpaceRequestMessage?.let { leaveSpace(it.spaceName); return }
```

- [ ] **Step 4: Run to verify GREEN**

Run: `cd android && ./gradlew --no-daemon :protocol:test`
Expected: PASS. If `leaveSpaceQuery` is never answered by the fake, the fire-and-forget query times out silently after 10 s inside the connection scope and is cancelled on `close()`; that is expected.

- [ ] **Step 5: Commit**

```bash
git add android/protocol && git commit -m "feat(android): join and leave proximity spaces on the server's request

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Voice events, signalling out, ICE servers

**Files:**
- Modify: `android/protocol/.../Spaces.kt`, `android/protocol/.../PusherConnection.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/PusherConnectionTest.kt`

**Interfaces:**
- Consumes: Task 1 `query`, Task 3 `leaveSpace`.
- Produces (in `Spaces.kt`):

```kotlin
sealed interface VoiceEvent {
    val spaceName: String
    /** [initiator] true means we must send the offer (not supported until M4). */
    data class Start(override val spaceName: String, val peerSpaceUserId: String, val connectionId: String, val initiator: Boolean) : VoiceEvent
    data class Signal(override val spaceName: String, val peerSpaceUserId: String, val connectionId: String, val signal: String) : VoiceEvent
    data class Disconnect(override val spaceName: String, val peerSpaceUserId: String) : VoiceEvent
    /** We left the space: every link in it must go. */
    data class SpaceLeft(override val spaceName: String) : VoiceEvent
}
data class IceServerInfo(val urls: List<String>, val username: String?, val credential: String?)
```

and on `PusherConnection`: `open val voiceEvents: SharedFlow<VoiceEvent>`, `open fun sendSignal(spaceName: String, peerSpaceUserId: String, connectionId: String, signal: String)`, `open suspend fun iceServers(): List<IceServerInfo>` (falls back to Google STUN if the query fails).

- [ ] **Step 1: Write the failing tests**

```kotlin
    private fun batch(vararg subs: SubMessage) = ServerToClientMessage(batchMessage = BatchMessage(payload = subs.toList()))
    private fun privateEvent(sender: String, ev: PrivateSpaceEvent) = SubMessage(privateEvent = PrivateEventPusherToFront(
        spaceName = "sp", receiverUserId = "me", sender = SpaceUser(spaceUserId = sender), spaceEvent = ev))

    @Test
    fun webRtcPrivateEventsBecomeVoiceEvents() = runBlocking<Unit> {
        val live = LiveFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            val events = java.util.concurrent.CopyOnWriteArrayList<VoiceEvent>()
            val collector = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { conn.voiceEvents.collect { events += it } }
            withTimeout(5_000) { conn.connect() }
            live.push(batch(
                privateEvent("sp_9", PrivateSpaceEvent(webRtcStartMessage = WebRtcStartMessage(userId = "x", initiator = false, connectionId = "c1"))),
                privateEvent("sp_9", PrivateSpaceEvent(webRtcSignal = WebRtcSignal(signal = "{\"type\":\"offer\"}", connectionId = "c1"))),
                privateEvent("sp_9", PrivateSpaceEvent(webRtcDisconnectMessage = WebRtcDisconnectMessage(userId = "x"))),
            ))
            waitFor { events.size == 3 }
            assertEquals(VoiceEvent.Start("sp", "sp_9", "c1", false), events[0])
            assertEquals(VoiceEvent.Signal("sp", "sp_9", "c1", "{\"type\":\"offer\"}"), events[1])
            assertEquals(VoiceEvent.Disconnect("sp", "sp_9"), events[2])
            collector.cancel(); conn.close()
        }
    }

    @Test
    fun otherPrivateEventsAreIgnoredAndLeavingASpaceEmitsSpaceLeft() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            val events = java.util.concurrent.CopyOnWriteArrayList<VoiceEvent>()
            val collector = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { conn.voiceEvents.collect { events += it } }
            withTimeout(5_000) { conn.connect() }
            live.push(batch(privateEvent("sp_9", PrivateSpaceEvent(muteAudio = MuteAudioPrivateMessage()))))
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp")))
            waitFor { conn.state.spaces.value.containsKey("sp") }
            live.push(ServerToClientMessage(leaveSpaceRequestMessage = LeaveSpaceRequestMessage(spaceName = "sp")))
            waitFor { events.isNotEmpty() }
            assertEquals(listOf<VoiceEvent>(VoiceEvent.SpaceLeft("sp")), events.toList())
            collector.cancel(); conn.close()
        }
    }

    @Test
    fun sendSignalAddressesTheRightPeerAndConnection() = runBlocking<Unit> {
        val live = LiveFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            conn.sendSignal("sp", "sp_9", "c1", "{\"type\":\"answer\",\"sdp\":\"x\"}")
            val pe = generateSequence { live.fake.received.poll(2, TimeUnit.SECONDS) }.first { it.privateEvent != null }.privateEvent!!
            assertEquals("sp", pe.spaceName); assertEquals("sp_9", pe.receiverUserId)
            assertEquals("c1", pe.spaceEvent!!.webRtcSignal!!.connectionId)
            assertEquals("{\"type\":\"answer\",\"sdp\":\"x\"}", pe.spaceEvent!!.webRtcSignal!!.signal)
            conn.close()
        }
    }

    @Test
    fun iceServersComeFromTheServerAndFallBackToStunWhenItFails() = runBlocking<Unit> {
        val ok = LiveFake { ws, msg -> msg.queryMessage?.let { q -> if (q.iceServersQuery != null) ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id,
            iceServersAnswer = IceServersAnswer(iceServers = listOf(IceServer(urls = listOf("turn:t.example:3478"), username = "u", credential = "c")))))))} }
        server(ok.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertEquals(listOf(IceServerInfo(listOf("turn:t.example:3478"), "u", "c")), conn.iceServers())
            conn.close()
        }
        val bad = LiveFake { ws, msg -> msg.queryMessage?.let { q -> ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, error = ErrorMessage(message = "no"))))) } }
        server(bad.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertEquals(listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null)), conn.iceServers())
            conn.close()
        }
    }
```

Imports: `BatchMessage`, `IceServer`, `IceServersAnswer`, `MuteAudioPrivateMessage`, `PrivateEventPusherToFront`, `PrivateSpaceEvent`, `WebRtcDisconnectMessage`, `WebRtcSignal`, `WebRtcStartMessage` (from `app.workadventurer.proto`), and `kotlinx.coroutines.launch` if absent.

- [ ] **Step 2: Run to verify RED**

Run: `cd android && ./gradlew --no-daemon :protocol:test --tests '*PusherConnectionTest*'`
Expected: compile FAIL (`VoiceEvent` unresolved).

- [ ] **Step 3: Implement.** Add the `VoiceEvent` and `IceServerInfo` declarations above to `Spaces.kt`. In `PusherConnection.kt` add imports `IceServersQuery`, `PrivateEvent`, `PrivateSpaceEvent`, `WebRtcSignal`, `SubMessage` and:

```kotlin
    private val _voiceEvents = MutableSharedFlow<VoiceEvent>(extraBufferCapacity = 64)

    /** WebRTC start/signal/disconnect from other space members, and "we left a space". */
    open val voiceEvents: SharedFlow<VoiceEvent> get() = _voiceEvents.asSharedFlow()

    open fun sendSignal(spaceName: String, peerSpaceUserId: String, connectionId: String, signal: String) {
        send(ClientToServerMessage(privateEvent = PrivateEvent(
            spaceName = spaceName, receiverUserId = peerSpaceUserId,
            spaceEvent = PrivateSpaceEvent(webRtcSignal = WebRtcSignal(signal = signal, connectionId = connectionId)),
        )))
    }

    open suspend fun iceServers(): List<IceServerInfo> = try {
        query { id -> QueryMessage(id = id, iceServersQuery = IceServersQuery()) }
            .iceServersAnswer?.iceServers.orEmpty()
            .map { IceServerInfo(it.urls, it.username, it.credential) }
            .ifEmpty { FALLBACK_ICE }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        _log.tryEmit("iceServersQuery failed (${e.message}); using default STUN")
        FALLBACK_ICE
    }

    private fun onPrivateEvent(p: app.workadventurer.proto.PrivateEventPusherToFront) {
        val peer = p.sender?.spaceUserId.orEmpty()
        val ev = p.spaceEvent ?: return
        ev.webRtcStartMessage?.let {
            _log.tryEmit("webRtcStart conn=${it.connectionId} initiator=${it.initiator}")
            _voiceEvents.tryEmit(VoiceEvent.Start(p.spaceName, peer, it.connectionId, it.initiator))
        }
        ev.webRtcSignal?.let { _voiceEvents.tryEmit(VoiceEvent.Signal(p.spaceName, peer, it.connectionId, it.signal)) }
        ev.webRtcDisconnectMessage?.let {
            _log.tryEmit("webRtcDisconnect from a peer in ${p.spaceName}")
            _voiceEvents.tryEmit(VoiceEvent.Disconnect(p.spaceName, peer))
        }
    }
```

Add to `Spaces.kt`: `internal val FALLBACK_ICE = listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null))`. In the batch loop of `handle`, change the `else` branch to also route private events:

```kotlin
                } else if (sub.privateEvent != null) {
                    onPrivateEvent(sub.privateEvent!!)
                } else {
```

In `leaveSpace`, after `state.removeSpace(spaceName)` add `_voiceEvents.tryEmit(VoiceEvent.SpaceLeft(spaceName))`.

- [ ] **Step 4: Run to verify GREEN**

Run: `cd android && ./gradlew --no-daemon :protocol:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/protocol && git commit -m "feat(android): voice events, signal sending and ICE servers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Live check M1, the space join (no new code)

**Files:** none (findings go in `android/docs/field-notes.md`).

- [ ] **Step 1: Install the current build** (`:app` already depends on `:protocol`, so the join works with no app change)

Run from `android/`: `./gradlew --no-daemon :app:assembleDebug` then `adb -s R5CY31ENYEH install -r app/build/outputs/apk/debug/app-debug.apk`.
Expected: `Success`.

- [ ] **Step 2: Join as `g3-voice`** and start a log capture: `adb -s R5CY31ENYEH logcat -c; adb -s R5CY31ENYEH logcat -v time -s WaConn:I WaSession:I AndroidRuntime:E` (background). Join the room from the app (name `g3-voice`).
Expected: "Connected".

- [ ] **Step 3: Ask the user (as David in the browser) to walk next to the phone's avatar** so a bubble forms.
Expected in the log: `entered bubble N`, then `joined space <name>`, then `webRtcStart conn=<id> initiator=<true|false>`. Record the initiator value and the space name shape.

- [ ] **Step 4: Ask the user to walk away.**
Expected: `left bubble`, `left space <name>`, and a `webRtcDisconnect` line. No `joinSpace ... failed` lines. Leave the room in the app.

- [ ] **Step 5: Record and commit.** Add a "G3 M1 live check" paragraph to `android/docs/field-notes.md` with the log lines above (names and counts only). If `joinSpace` failed or no `webRtcStart` arrived, STOP: the next tasks depend on this, so diagnose against `src/wa-client.mjs` `_joinSpace` before continuing.

```bash
git add android/docs && git commit -m "docs(android): G3 M1 live check, space join

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `:voice` signalling codec

**Files:**
- Modify: `android/voice/build.gradle.kts`
- Create: `android/voice/src/main/kotlin/app/workadventurer/voice/SimplePeerSignal.kt`
- Test: `android/voice/src/test/kotlin/app/workadventurer/voice/SimplePeerSignalTest.kt`

**Interfaces:**
- Produces:

```kotlin
sealed interface PeerSignal {
    data class Offer(val sdp: String) : PeerSignal
    data class Answer(val sdp: String) : PeerSignal
    data class Candidate(val candidate: String, val sdpMid: String?, val sdpMLineIndex: Int) : PeerSignal
}
object SimplePeerSignal {
    /** Null for anything we don't act on (renegotiate, transceiverRequest, garbage). Never throws. */
    fun parse(json: String): PeerSignal?
    fun answer(sdp: String): String
}
```

- [ ] **Step 1: Build setup.** In `android/voice/build.gradle.kts` add `alias(libs.plugins.kotlin.serialization)` to `plugins`, and to `dependencies`: `api(project(":protocol"))`, `implementation(libs.serialization.json)`, `testImplementation(libs.coroutines.test)`. In `android/build.gradle.kts` the serialization plugin is already declared `apply false`.

- [ ] **Step 2: Write the failing test**

```kotlin
package app.workadventurer.voice

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SimplePeerSignalTest {
    @Test
    fun parsesAnOfferAndAnAnswer() {
        assertEquals(PeerSignal.Offer("v=0\r\n"), SimplePeerSignal.parse("""{"type":"offer","sdp":"v=0\r\n"}"""))
        assertEquals(PeerSignal.Answer("x"), SimplePeerSignal.parse("""{"type":"answer","sdp":"x"}"""))
    }

    @Test
    fun parsesATrickleCandidate() {
        val s = SimplePeerSignal.parse("""{"type":"candidate","candidate":{"candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host","sdpMid":"1","sdpMLineIndex":1}}""")
        assertEquals(PeerSignal.Candidate("candidate:1 1 udp 1 1.2.3.4 5 typ host", "1", 1), s)
    }

    // Review Focus 5: nothing we don't understand may throw.
    @Test
    fun ignoresRenegotiateUnknownAndGarbage() {
        assertNull(SimplePeerSignal.parse("""{"type":"renegotiate"}"""))
        assertNull(SimplePeerSignal.parse("""{"transceiverRequest":{"kind":"video"}}"""))
        assertNull(SimplePeerSignal.parse("""{"type":"offer"}""")) // no sdp
        assertNull(SimplePeerSignal.parse("{{{ not json"))
        assertNull(SimplePeerSignal.parse(""))
        assertNull(SimplePeerSignal.parse("""[1,2,3]"""))
        assertNull(SimplePeerSignal.parse("""{"type":"candidate","candidate":"not an object"}"""))
    }

    @Test
    fun anAnswerSerialisesInSimplePeersShape() {
        val json = SimplePeerSignal.answer("v=0\r\ns=-\r\n")
        assertEquals(PeerSignal.Answer("v=0\r\ns=-\r\n"), SimplePeerSignal.parse(json))
        assertEquals(true, json.contains("\"type\":\"answer\""))
    }
}
```

- [ ] **Step 3: Run to verify RED**

Run: `cd android && ./gradlew --no-daemon :voice:testDebugUnitTest`
Expected: compile FAIL (`SimplePeerSignal` unresolved).

- [ ] **Step 4: Implement**

```kotlin
package app.workadventurer.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

sealed interface PeerSignal {
    data class Offer(val sdp: String) : PeerSignal
    data class Answer(val sdp: String) : PeerSignal
    data class Candidate(val candidate: String, val sdpMid: String?, val sdpMLineIndex: Int) : PeerSignal
}

/** WorkAdventure's browser peers use simple-peer: signals are JSON strings in `{type, sdp | candidate}` shape. */
object SimplePeerSignal {
    private fun JsonElement?.str() = (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    fun parse(json: String): PeerSignal? {
        val o = try { Json.parseToJsonElement(json) as? JsonObject } catch (e: Exception) { null } ?: return null
        return when (o["type"].str()) {
            "offer" -> o["sdp"].str()?.let { PeerSignal.Offer(it) }
            "answer" -> o["sdp"].str()?.let { PeerSignal.Answer(it) }
            "candidate" -> {
                val c = o["candidate"] as? JsonObject ?: return null
                val line = c["candidate"].str() ?: return null
                PeerSignal.Candidate(line, c["sdpMid"].str(), (c["sdpMLineIndex"] as? JsonPrimitive)?.intOrNull ?: 0)
            }
            else -> null // renegotiate, transceiverRequest, unknown
        }
    }

    fun answer(sdp: String): String = buildJsonObject { put("type", "answer"); put("sdp", sdp) }.toString()
}
```

- [ ] **Step 5: Run to verify GREEN, then commit**

Run: `cd android && ./gradlew --no-daemon :voice:testDebugUnitTest` (Expected: PASS).

```bash
git add android/voice android/build.gradle.kts && git commit -m "feat(android): simple-peer signal codec for the voice mesh

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `MeshSession`

**Files:**
- Create: `android/voice/src/main/kotlin/app/workadventurer/voice/MeshSession.kt`
- Test: `android/voice/src/test/kotlin/app/workadventurer/voice/MeshSessionTest.kt`

**Interfaces:**
- Consumes: `VoiceEvent` (Task 4), `PeerSignal`/`SimplePeerSignal` (Task 6).
- Produces:

```kotlin
interface PeerLink {
    /** The answer SDP for [offerSdp], or null if it can't be used (for example zero ICE candidates). */
    suspend fun acceptOffer(offerSdp: String): String?
    fun addRemoteCandidate(candidate: PeerSignal.Candidate)
    fun close()
}
fun interface PeerLinkFactory { suspend fun create(connectionId: String): PeerLink }
fun interface SignalSink { fun send(spaceName: String, peerSpaceUserId: String, connectionId: String, signal: String) }

class MeshSession(links: PeerLinkFactory, sink: SignalSink, log: (String) -> Unit) {
    suspend fun run(events: Flow<VoiceEvent>)   // collects until cancelled
    fun closeAll()
    val activeConnections: Set<String>
}
```

- [ ] **Step 1: Write the failing tests**

```kotlin
package app.workadventurer.voice

import app.workadventurer.protocol.VoiceEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MeshSessionTest {
    private class FakeLink(val id: String, var answer: String? = "ANSWER-SDP") : PeerLink {
        val offers = mutableListOf<String>(); val candidates = mutableListOf<PeerSignal.Candidate>(); var closed = false
        override suspend fun acceptOffer(offerSdp: String): String? { offers += offerSdp; return answer }
        override fun addRemoteCandidate(candidate: PeerSignal.Candidate) { candidates += candidate }
        override fun close() { closed = true }
    }

    private class Rig {
        val made = mutableMapOf<String, FakeLink>(); val sent = mutableListOf<List<String>>(); val logs = mutableListOf<String>()
        var nextAnswer: String? = "ANSWER-SDP"
        val mesh = MeshSession(
            links = { id -> FakeLink(id, nextAnswer).also { made[id] = it } },
            sink = { space, peer, conn, signal -> sent += listOf(space, peer, conn, signal) },
            log = { logs += it },
        )
        val events = MutableSharedFlow<VoiceEvent>(extraBufferCapacity = 16)
    }

    private fun offer(conn: String = "c1", peer: String = "sp_9") = VoiceEvent.Signal("sp", peer, conn, """{"type":"offer","sdp":"OFFER"}""")

    @Test
    fun aNonInitiatorStartThenAnOfferIsAnsweredToTheSender() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", initiator = false)); r.events.emit(offer()); advanceUntilIdle()
        assertEquals(listOf("OFFER"), r.made.getValue("c1").offers)
        assertEquals(listOf("sp", "sp_9", "c1", """{"type":"answer","sdp":"ANSWER-SDP"}"""), r.sent.single())
        assertEquals(setOf("c1"), r.mesh.activeConnections); job.cancel()
    }

    @Test
    fun anOfferWithoutAStartStillCreatesTheLinkAndIsAnswered() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(offer()); advanceUntilIdle()
        assertEquals(1, r.sent.size); job.cancel()
    }

    // Review Focus 4
    @Test
    fun aDuplicateStartDoesNotCreateASecondLink() = runTest {
        val r = Rig(); var creates = 0
        val mesh = MeshSession({ id -> creates++; FakeLink(id) }, { _, _, _, _ -> }, {})
        val job = backgroundScope.launch { mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", false)); r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", false)); advanceUntilIdle()
        assertEquals(1, creates); job.cancel()
    }

    @Test
    fun anInitiatorStartIsLoggedAsUnsupportedAndCreatesNothing() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", initiator = true)); advanceUntilIdle()
        assertTrue(r.made.isEmpty()); assertTrue(r.logs.any { "initiator" in it }); job.cancel()
    }

    // Review Focus 2
    @Test
    fun anAnswerWithNoUsableCandidatesClosesTheLinkAndSendsNothing() = runTest {
        val r = Rig(); r.nextAnswer = null
        val job = backgroundScope.launch { r.mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(offer()); advanceUntilIdle()
        assertTrue(r.made.getValue("c1").closed); assertTrue(r.sent.isEmpty()); assertTrue(r.mesh.activeConnections.isEmpty()); job.cancel()
    }

    // Review Focus 1 and 3
    @Test
    fun signalsForATornDownConnectionAreIgnoredAndNeverResurrectIt() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(offer()); advanceUntilIdle()
        r.events.emit(VoiceEvent.Disconnect("sp", "sp_9")); advanceUntilIdle()
        assertTrue(r.made.getValue("c1").closed)
        r.events.emit(offer()); r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", false)); advanceUntilIdle()
        assertEquals(1, r.made.size); assertEquals(1, r.sent.size); assertTrue(r.mesh.activeConnections.isEmpty()); job.cancel()
    }

    @Test
    fun aDisconnectClosesOnlyThatPeersLinks() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(offer("c1", "sp_9")); r.events.emit(offer("c2", "sp_8")); advanceUntilIdle()
        r.events.emit(VoiceEvent.Disconnect("sp", "sp_9")); advanceUntilIdle()
        assertTrue(r.made.getValue("c1").closed); assertEquals(false, r.made.getValue("c2").closed)
        assertEquals(setOf("c2"), r.mesh.activeConnections); job.cancel()
    }

    @Test
    fun leavingTheSpaceClosesEveryLinkInIt() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(offer("c1", "sp_9")); r.events.emit(offer("c2", "sp_8")); advanceUntilIdle()
        r.events.emit(VoiceEvent.SpaceLeft("sp")); advanceUntilIdle()
        assertTrue(r.made.values.all { it.closed }); assertTrue(r.mesh.activeConnections.isEmpty()); job.cancel()
    }

    // Review Focus 5
    @Test
    fun garbageAndUnknownSignalsDoNotCrashTheMeshOrStopLaterEvents() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(VoiceEvent.Signal("sp", "sp_9", "c1", "{{{ nope")); r.events.emit(VoiceEvent.Signal("sp", "sp_9", "c1", """{"type":"renegotiate"}"""))
        r.events.emit(offer("c2")); advanceUntilIdle()
        assertEquals(1, r.sent.size); job.cancel()
    }

    @Test
    fun candidatesGoToTheLinkAndALinkThatThrowsOnOfferIsDropped() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(offer()); advanceUntilIdle()
        r.events.emit(VoiceEvent.Signal("sp", "sp_9", "c1", """{"type":"candidate","candidate":{"candidate":"candidate:1","sdpMid":"1","sdpMLineIndex":1}}""")); advanceUntilIdle()
        assertEquals(listOf(PeerSignal.Candidate("candidate:1", "1", 1)), r.made.getValue("c1").candidates)
        val boom = MeshSession({ object : PeerLink {
            override suspend fun acceptOffer(offerSdp: String): String? = throw IllegalStateException("libwebrtc said no")
            override fun addRemoteCandidate(candidate: PeerSignal.Candidate) {}
            override fun close() {} } }, { _, _, _, _ -> }, {})
        val ev = MutableSharedFlow<VoiceEvent>(extraBufferCapacity = 4)
        val j2 = backgroundScope.launch { boom.run(ev) }; advanceUntilIdle()
        ev.emit(offer()); advanceUntilIdle()
        assertTrue(boom.activeConnections.isEmpty()); job.cancel(); j2.cancel()
    }

    @Test
    fun closeAllClosesEverything() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; advanceUntilIdle()
        r.events.emit(offer("c1")); r.events.emit(offer("c2", "sp_8")); advanceUntilIdle()
        r.mesh.closeAll()
        assertTrue(r.made.values.all { it.closed }); assertTrue(r.mesh.activeConnections.isEmpty()); job.cancel()
    }
}
```

- [ ] **Step 2: Run to verify RED**

Run: `cd android && ./gradlew --no-daemon :voice:testDebugUnitTest --tests '*MeshSessionTest*'`
Expected: compile FAIL (`MeshSession` unresolved).

- [ ] **Step 3: Implement**

```kotlin
package app.workadventurer.voice

import app.workadventurer.protocol.VoiceEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow

interface PeerLink {
    /** The answer SDP for [offerSdp], or null if it can't be used (for example zero ICE candidates). */
    suspend fun acceptOffer(offerSdp: String): String?
    fun addRemoteCandidate(candidate: PeerSignal.Candidate)
    fun close()
}

fun interface PeerLinkFactory { suspend fun create(connectionId: String): PeerLink }
fun interface SignalSink { fun send(spaceName: String, peerSpaceUserId: String, connectionId: String, signal: String) }

/**
 * One WebRTC link per server-assigned connection id (a 3-person bubble is a mesh). Events are handled one at a time, in
 * order. Answerer only until M4: a start with `initiator = true` is logged and ignored.
 */
class MeshSession(
    private val links: PeerLinkFactory,
    private val sink: SignalSink,
    private val log: (String) -> Unit,
) {
    private class Entry(val spaceName: String, val peer: String, val link: PeerLink)

    private val active = LinkedHashMap<String, Entry>()
    private val closedIds = LinkedHashSet<String>() // late signals for these are dropped, never resurrected

    val activeConnections: Set<String> get() = synchronized(active) { active.keys.toSet() }

    suspend fun run(events: Flow<VoiceEvent>) {
        events.collect { e ->
            try { handle(e) } catch (c: CancellationException) { throw c } catch (t: Throwable) { log("voice event failed: ${t.message}") }
        }
    }

    private suspend fun handle(e: VoiceEvent) {
        when (e) {
            is VoiceEvent.Start -> {
                if (e.initiator) { log("[${e.connectionId}] we are asked to initiate: not supported yet, ignoring"); return }
                if (e.connectionId in closedIds) return
                link(e.spaceName, e.peerSpaceUserId, e.connectionId)
            }
            is VoiceEvent.Signal -> {
                if (e.connectionId in closedIds) { log("[${e.connectionId}] signal for a closed connection, ignored"); return }
                when (val s = SimplePeerSignal.parse(e.signal)) {
                    is PeerSignal.Offer -> answer(e, s)
                    is PeerSignal.Candidate -> synchronized(active) { active[e.connectionId] }?.link?.addRemoteCandidate(s)
                    is PeerSignal.Answer -> log("[${e.connectionId}] unexpected answer (we never offer yet), ignored")
                    null -> log("[${e.connectionId}] unparseable or unsupported signal, ignored")
                }
            }
            is VoiceEvent.Disconnect -> closeWhere { it.spaceName == e.spaceName && it.peer == e.peerSpaceUserId }
            is VoiceEvent.SpaceLeft -> closeWhere { it.spaceName == e.spaceName }
        }
    }

    private suspend fun link(space: String, peer: String, id: String): PeerLink {
        synchronized(active) { active[id] }?.let { return it.link }
        val l = links.create(id)
        synchronized(active) { active[id] = Entry(space, peer, l) }
        return l
    }

    private suspend fun answer(e: VoiceEvent.Signal, offer: PeerSignal.Offer) {
        val l = link(e.spaceName, e.peerSpaceUserId, e.connectionId)
        val sdp = try { l.acceptOffer(offer.sdp) } catch (c: CancellationException) { throw c } catch (t: Throwable) {
            log("[${e.connectionId}] offer failed: ${t.message}"); null
        }
        if (sdp == null) { log("[${e.connectionId}] no usable answer, tearing down"); drop(e.connectionId); return }
        sink.send(e.spaceName, e.peerSpaceUserId, e.connectionId, SimplePeerSignal.answer(sdp))
        log("[${e.connectionId}] answered")
    }

    private fun closeWhere(match: (Entry) -> Boolean) {
        val ids = synchronized(active) { active.filterValues(match).keys.toList() }
        ids.forEach { drop(it) }
    }

    private fun drop(id: String) {
        val entry = synchronized(active) { active.remove(id) }
        synchronized(closedIds) {
            closedIds += id
            if (closedIds.size > 64) closedIds.remove(closedIds.first())
        }
        try { entry?.link?.close() } catch (t: Throwable) { log("[$id] close failed: ${t.message}") }
    }

    fun closeAll() { synchronized(active) { active.keys.toList() }.forEach { drop(it) } }
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `cd android && ./gradlew --no-daemon :voice:testDebugUnitTest`
Expected: PASS (all `SimplePeerSignalTest` and `MeshSessionTest` tests).

- [ ] **Step 5: Commit**

```bash
git add android/voice && git commit -m "feat(android): MeshSession answers browser peers over a fake-able PeerLink

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `VoiceEngine` and `WebRtcPeerLink` (libwebrtc), checked on the phone

**Files:**
- Create: `android/voice/src/main/kotlin/app/workadventurer/voice/VoiceEngine.kt`, `.../WebRtcPeerLink.kt`
- Create: `android/voice/src/androidTest/assets/live-browser-offer-with-video.sdp` (copy of the repo's `test/fixtures/live-browser-offer-with-video.sdp`)
- Create: `android/voice/src/androidTest/kotlin/app/workadventurer/voice/AnswerRealBrowserOfferTest.kt`
- Delete: `android/voice/src/androidTest/kotlin/app/workadventurer/voice/WebRtcSpikeTest.kt`

**Interfaces:**
- Consumes: `PeerLink`, `PeerLinkFactory` (Task 7), `IceServerInfo` (Task 4).
- Produces: `class VoiceEngine(context: Context)` with `suspend fun newLink(connectionId: String, iceServers: List<IceServerInfo>): PeerLink` (waits until the engine is at least 1,500 ms old) and `fun close()`; `internal class WebRtcPeerLink : PeerLink`.

- [ ] **Step 1: Copy the fixture and write the failing instrumented test**

Run: `mkdir -p android/voice/src/androidTest/assets && cp test/fixtures/live-browser-offer-with-video.sdp android/voice/src/androidTest/assets/`.

```kotlin
package app.workadventurer.voice

import androidx.test.platform.app.InstrumentationRegistry
import app.workadventurer.protocol.IceServerInfo
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

// Run on the phone: ./gradlew :voice:connectedDebugAndroidTest
class AnswerRealBrowserOfferTest {
    // The exact offer a real WorkAdventure browser peer sent (m=video first, then audio, then the data channel). werift
    // threw on its video section; libwebrtc must answer it.
    @Test
    fun answersTheCapturedRealBrowserOffer() = runBlocking {
        val inst = InstrumentationRegistry.getInstrumentation()
        val offer = inst.context.assets.open("live-browser-offer-with-video.sdp").bufferedReader().readText()
        val engine = VoiceEngine(inst.targetContext)
        try {
            val link = engine.newLink("c1", listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null)))
            val answer = withTimeout(15_000) { link.acceptOffer(offer) }
            assertNotNull(answer, "no usable answer")
            println("ANSWER-SDP-BEGIN\n$answer\nANSWER-SDP-END")
            assertTrue(Regex("m=audio [1-9]").containsMatchIn(answer), "audio section not accepted")
            assertTrue("opus/48000" in answer)
            assertTrue(Regex("m=video 0 ").containsMatchIn(answer), "video section should be rejected, not crash")
            assertTrue(Regex("m=application [1-9]").containsMatchIn(answer), "data channel not accepted")
            assertTrue("a=candidate" in answer, "answer has no ICE candidates")
            link.close()
        } finally { engine.close() }
    }
}
```

- [ ] **Step 2: Run to verify RED**

Run: `cd android && ./gradlew --no-daemon :voice:connectedDebugAndroidTest` (phone connected and unlocked).
Expected: compile FAIL (`VoiceEngine` unresolved).

- [ ] **Step 3: Implement `VoiceEngine.kt`**

```kotlin
package app.workadventurer.voice

import android.content.Context
import app.workadventurer.protocol.IceServerInfo
import kotlinx.coroutines.delay
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.audio.JavaAudioDeviceModule

/**
 * Owns the one libwebrtc [PeerConnectionFactory]. Create it at join, not at the first bubble: gathering that starts right
 * after the factory exists finds no network (0 candidates), so links wait until the engine is [WARM_UP_MS] old.
 */
class VoiceEngine(context: Context) {
    private val createdAt = System.nanoTime()
    internal val factory: PeerConnectionFactory

    init {
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
        val audio = JavaAudioDeviceModule.builder(context.applicationContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        factory = PeerConnectionFactory.builder().setAudioDeviceModule(audio).createPeerConnectionFactory()
        audio.release() // the factory holds its own reference
    }

    suspend fun newLink(connectionId: String, iceServers: List<IceServerInfo>): PeerLink {
        val waited = (System.nanoTime() - createdAt) / 1_000_000
        if (waited < WARM_UP_MS) delay(WARM_UP_MS - waited)
        return WebRtcPeerLink(factory, connectionId, iceServers)
    }

    fun close() { factory.dispose() }

    companion object { const val WARM_UP_MS = 1_500L }
}
```

- [ ] **Step 4: Implement `WebRtcPeerLink.kt`**

```kotlin
package app.workadventurer.voice

import app.workadventurer.protocol.IceServerInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription

/** The answering side of one simple-peer connection. Remote audio plays through the audio device module on its own. */
internal class WebRtcPeerLink(
    factory: PeerConnectionFactory,
    private val connectionId: String,
    iceServers: List<IceServerInfo>,
) : PeerLink {
    private val gathered = CompletableDeferred<Unit>()
    private val keepAlive = mutableListOf<Any>() // data channel references: libwebrtc drops channels nobody holds

    private val pc: PeerConnection = factory.createPeerConnection(
        PeerConnection.RTCConfiguration(iceServers.map {
            PeerConnection.IceServer.builder(it.urls).apply { it.username?.let(::setUsername); it.credential?.let(::setPassword) }.createIceServer()
        }).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN },
        object : PeerConnection.Observer {
            override fun onSignalingChange(s: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) { if (s == PeerConnection.IceGatheringState.COMPLETE) gathered.complete(Unit) }
            override fun onIceCandidate(c: IceCandidate) {}
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
            override fun onAddStream(s: MediaStream) {}
            override fun onRemoveStream(s: MediaStream) {}
            override fun onDataChannel(d: DataChannel) { synchronized(keepAlive) { keepAlive += d } }
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver, s: Array<out MediaStream>) {}
        },
    ) ?: error("createPeerConnection returned null")

    private class Await<T>(private val done: CompletableDeferred<T>, private val onCreate: ((SessionDescription) -> Unit)? = null) : SdpObserver {
        override fun onCreateSuccess(d: SessionDescription) { onCreate?.invoke(d) }
        override fun onSetSuccess() { @Suppress("UNCHECKED_CAST") (done as CompletableDeferred<Unit>).complete(Unit) }
        override fun onCreateFailure(e: String) { done.completeExceptionally(IllegalStateException("create: $e")) }
        override fun onSetFailure(e: String) { done.completeExceptionally(IllegalStateException("set: $e")) }
    }

    override suspend fun acceptOffer(offerSdp: String): String? {
        val remoteSet = CompletableDeferred<Unit>()
        pc.setRemoteDescription(Await(remoteSet), SessionDescription(SessionDescription.Type.OFFER, offerSdp))
        remoteSet.await()

        val created = CompletableDeferred<SessionDescription>()
        pc.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) { created.complete(d) }
            override fun onSetSuccess() {}
            override fun onCreateFailure(e: String) { created.completeExceptionally(IllegalStateException("answer: $e")) }
            override fun onSetFailure(e: String) {}
        }, MediaConstraints())
        val answer = created.await()

        val localSet = CompletableDeferred<Unit>()
        pc.setLocalDescription(Await(localSet), answer)
        localSet.await()

        withTimeoutOrNull(GATHER_TIMEOUT_MS) { gathered.await() } // non-trickle: the answer carries every candidate
        val sdp = pc.localDescription?.description ?: return null
        return sdp.takeIf { "a=candidate" in it } // zero candidates is a dead connection: the caller tears down
    }

    override fun addRemoteCandidate(candidate: PeerSignal.Candidate) {
        pc.addIceCandidate(IceCandidate(candidate.sdpMid, candidate.sdpMLineIndex, candidate.candidate))
    }

    override fun close() {
        try { pc.close() } finally { pc.dispose() }
    }

    companion object { const val GATHER_TIMEOUT_MS = 4_000L }
}
```

Delete the throwaway spike: `git rm android/voice/src/androidTest/kotlin/app/workadventurer/voice/WebRtcSpikeTest.kt`.

- [ ] **Step 5: Run to verify GREEN on the phone**

Run: `cd android && ./gradlew --no-daemon :voice:connectedDebugAndroidTest`
Expected: `AnswerRealBrowserOfferTest` PASS. The printed answer should show `m=video 0`, an accepted `m=audio`, and `m=application`. If the answer contains no candidate, check that the 1,500 ms warm-up ran. If it fails on the data channel, ledger it as a Ruling and read `docs/field-notes.md` "simple-peer needs a data channel": the fallback is to create a `simplepeer` channel on the link before `setRemoteDescription`, as the Node client does; re-run.

- [ ] **Step 6: Commit**

```bash
git add -A android/voice && git commit -m "feat(android): libwebrtc VoiceEngine and WebRtcPeerLink answering a real browser offer

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Wire the mesh into the app

**Files:**
- Modify: `android/app/build.gradle.kts`, `android/app/src/main/kotlin/app/workadventurer/app/session/WaSession.kt`, `android/app/src/main/kotlin/app/workadventurer/app/WaApp.kt`
- Create: `android/app/src/main/kotlin/app/workadventurer/app/MeshVoiceHost.kt`
- Test: `android/app/src/test/kotlin/app/workadventurer/app/session/WaSessionTest.kt`

**Interfaces:**
- Consumes: `PusherConnection.voiceEvents/sendSignal/iceServers` (Task 4), `MeshSession`, `VoiceEngine` (Tasks 7, 8).
- Produces: `typealias VoiceHost = (PusherConnection) -> AutoCloseable` and a `voiceHost: VoiceHost = { AutoCloseable { } }` constructor parameter on `WaSession` (placed last); the host is invoked once per live connection after `Connected` and closed when that connection ends (drop, Leave, failed join).

- [ ] **Step 1: Write the failing tests** (append in `WaSessionTest`, using the existing `FakeConn`, `cfg`, `join`)

```kotlin
    @Test
    fun theVoiceHostStartsOnceConnectedAndIsClosedWhenTheConnectionDrops() = runTest {
        val started = mutableListOf<PusherConnection>(); var closed = 0
        var conn: FakeConn? = null
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { conn = it } }, nowMs = { testScheduler.currentTime },
            voiceHost = { c -> started += c; AutoCloseable { closed++ } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        assertEquals(1, started.size); assertEquals(0, closed)
        conn!!.fakeClosed.complete(Closed(1006, "net")); runCurrent()
        assertEquals(1, closed)
    }

    @Test
    fun leaveClosesTheVoiceHostAndAReconnectStartsAFreshOne() = runTest {
        var starts = 0; var closes = 0
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { } }, nowMs = { testScheduler.currentTime },
            voiceHost = { starts++; AutoCloseable { closes++ } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.Leave); runCurrent()
        assertEquals(1, closes)
        session.dispatch(Command.Join(cfg)); runCurrent()
        assertEquals(2, starts)
    }

    @Test
    fun aVoiceHostThatThrowsDoesNotBreakPresence() = runTest {
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { } }, nowMs = { testScheduler.currentTime },
            voiceHost = { error("libwebrtc missing") })
        session.dispatch(Command.Join(cfg)); runCurrent()
        assertEquals(Connection.Connected, session.state.value.connection)
    }
```

- [ ] **Step 2: Run to verify RED**

Run: `cd android && ./gradlew --no-daemon :app:testDebugUnitTest --tests '*WaSessionTest*'`
Expected: compile FAIL (`voiceHost` is not a parameter).

- [ ] **Step 3: Implement the seam.** In `WaSession.kt` add `typealias VoiceHost = (PusherConnection) -> AutoCloseable` next to `ConnectionFactory`, add `private val voiceHost: VoiceHost = { AutoCloseable { } },` as the last constructor parameter, and in `run`, right after the `setState(gen) { it.copy(connection = Connection.Connected, areas = c.state.areas) }` line:

```kotlin
                voice = try { voiceHost(c) } catch (e: Exception) { null } // voice must never take presence down with it
```

Declare `var voice: AutoCloseable? = null` next to `var upAt = -1L`, and in the `finally { ... }` block before `c.close()` add `try { voice?.close() } catch (e: Exception) { }`.

- [ ] **Step 4: Run to verify GREEN**

Run: `cd android && ./gradlew --no-daemon :app:testDebugUnitTest`
Expected: PASS.

- [ ] **Step 5: Implement the real host.** In `android/app/build.gradle.kts` add `implementation(project(":voice"))`. Create `MeshVoiceHost.kt`:

```kotlin
package app.workadventurer.app

import android.content.Context
import android.media.AudioManager
import android.util.Log
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.voice.MeshSession
import app.workadventurer.voice.VoiceEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Starts the voice mesh for one live connection and tears it down with it. Platform glue: verified on the phone. */
class MeshVoiceHost(private val context: Context) : (PusherConnection) -> AutoCloseable {
    override fun invoke(conn: PusherConnection): AutoCloseable {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val audio = context.getSystemService(AudioManager::class.java)
        val previousMode = audio.mode
        audio.mode = AudioManager.MODE_IN_COMMUNICATION // voice-call routing and volume
        val engine = VoiceEngine(context) // at join, so the network list is known by the first bubble
        val ice = scope.async { conn.iceServers() }
        val mesh = MeshSession(
            links = { id -> engine.newLink(id, ice.await()) },
            sink = { space, peer, id, signal -> conn.sendSignal(space, peer, id, signal) },
            log = { Log.i("WaVoice", it) },
        )
        scope.launch { mesh.run(conn.voiceEvents) }
        return AutoCloseable {
            scope.cancel()
            mesh.closeAll()
            engine.close()
            audio.mode = previousMode
        }
    }
}
```

In `WaApp.kt` pass `voiceHost = MeshVoiceHost(this)` when constructing `WaSession` (read the file first and follow its existing construction style).

- [ ] **Step 6: Build and commit**

Run: `cd android && ./gradlew --no-daemon test :app:assembleDebug` (Expected: BUILD SUCCESSFUL, all tests pass).

```bash
git add android && git commit -m "feat(android): run the voice mesh for each live connection

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live check M2, hear a browser peer

**Files:** `android/docs/field-notes.md` (findings).

- [ ] **Step 1: Install**: `./gradlew --no-daemon :app:assembleDebug` then `adb -s R5CY31ENYEH install -r app/build/outputs/apk/debug/app-debug.apk`. Start a log capture with `adb -s R5CY31ENYEH logcat -c; adb -s R5CY31ENYEH logcat -v time -s WaConn:I WaSession:I WaVoice:I AndroidRuntime:E libc:F` in the background.

- [ ] **Step 2: Join as `g3-voice`** in the app (grant the microphone permission if asked), then ask the user, as David in the browser, to join the same room with their microphone on and walk next to the phone's avatar.
Expected log: `entered bubble`, `joined space`, `webRtcStart conn=... initiator=false`, then `[conn] answered`. In the browser, the phone's tile should reach "connected" rather than stay at "Connecting…". If it hangs at Connecting, ledger a Ruling and apply the data-channel fallback in Task 8 Step 5.

- [ ] **Step 3: Ask the user to speak** (counting aloud for 10 s) and report whether the phone plays it. Then ask for the same with the screen locked (lock it over adb: `adb -s R5CY31ENYEH shell input keyevent 26`).
Expected: audible on the phone's speaker, also with the screen off. Note the volume and any echo or dropouts.

- [ ] **Step 4: Churn.** Ask the user to walk away and back three times.
Expected: `webRtcDisconnect`/`left space`, then a fresh `webRtcStart` with a new connection id and `answered` each time; no crash, and `adb shell dumpsys meminfo app.workadventurer | grep -i "TOTAL "` stays roughly flat across the three rounds.

- [ ] **Step 5: Test the offerer case's boundary.** Ask the user to leave and rejoin the bubble while the phone stays still, then a second browser peer to join if available.
Expected: any `initiator=true` start is logged as "not supported yet, ignoring" (that is M4); record how often it happens, since it decides how soon M4 is needed.

- [ ] **Step 6: Leave the room, stop the log capture, record and commit** a "G3 M2 live check" section in `android/docs/field-notes.md` (what was heard, locked-screen result, churn result, the initiator frequency, memory numbers), then:

```bash
git add android/docs && git commit -m "docs(android): G3 M2 live check, hearing a browser peer

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
