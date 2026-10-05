# Android client G0 + G1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a Kotlin client can join a WorkAdventure room as an avatar and see other players (G0, JVM CLI), then that this presence survives on an Android phone with the screen locked (G1, foreground service + Compose list).

**Architecture:** `:protocol` is a pure-JVM Gradle module: Wire-generated classes from `../proto/wa-1.33/messages.proto`, the `seq-len-v1` envelope, anonymous login, map-area/spawn lookup, an OkHttp WebSocket `PusherConnection`, and a `RoomState` reducer that exposes `StateFlow`s. `:wa-cli` is a thin JVM `main` over it (G0 live check). `:app` adds `WaSession` (state + `dispatch(Command)`, no Android imports so it unit-tests on the JVM), a `PresenceService` foreground service and a Compose UI (G1). Everything mirrors `src/wa-client.mjs`; read it alongside each task.

**Tech Stack:** Kotlin 2.0.21, Gradle 8.10.2 (wrapper), Wire 5.2.1 (protobuf codegen), OkHttp 4.12.0 (+ `mockwebserver`), kotlinx-coroutines 1.9.0, kotlinx-serialization-json 1.7.3, AGP 8.7.3, Jetpack Compose (BOM 2024.10.01), JUnit4 + `kotlin-test`. Versions are starting pins; bump only if Gradle sync demands it, and record the bump in `android/docs/field-notes.md`.

**Spec:** `docs/superpowers/specs/2026-10-05-android-client-design.md` (gates G0 and G1). Issue: #54.

## Global Constraints

- Prototype lives in `android/`. **Nothing in `android/` references the repo outside `android/`, except Gradle reading `../proto/`.** No reaching into `src/`.
- Target prod `play.workadventu.re` via the **wa-1.33 adapter only**. Defaults: pusher `https://pusher.workadventu.re`, room `https://play.workadventu.re/@/afrolabs/afrolabs/open-space`, woka `506a3a64-47a9-4587-b19b-2d1eb13f9790`, `apiVersionHash` `05489a87` (accepted set: `05489a87`, `bfd20fc4`).
- Anonymous login only. No video, no audio in this plan (G3).
- Wire/audio behaviour is proven by **live checks**, not unit tests (field-notes "Testing approach"). Unit tests cover only pure logic.
- CLAUDE.md hygiene for any live avatar: name it after the worktree/branch (never bare `claude`); any Node `wa` daemon used as the browser-side stand-in uses its own port, never `8787` (check `lsof -iTCP -sTCP:LISTEN -P | grep node` first); `wa leave` / kill when done.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. PRs merge with a plain merge commit, never squash.
- Package root: `app.workadventurer`. minSdk 26, compileSdk/targetSdk 34 (an API 35 emulator, `Medium_Phone`, is installed; no API 35 platform, which is fine).

## Review Focus

Inputs the spec implies but no happy-path test exercises, most likely first:

1. **`userMovedMessage` for a userId we never saw** (events arrive before/without the join): must be ignored, not crash the reducer. (Task 4)
2. **Join-time server errors** (`errorScreenMessage`, `invalidCharacterTextureMessage`, `tokenExpiredMessage`, close before `roomJoinedMessage`): `connect()` must fail with a message, never hang. (Task 5)
3. **Envelope frames with several payloads or a length ≥ 128 bytes** (multi-byte varint): the CLI batches field 2; a single-byte-length-only decoder silently drops data. (Task 1)
4. **Map areas / `/map` fetch fails or the room has no `.wam`**: join must still succeed with an empty area list and the fallback spawn `(320,320)`. (Task 3)
5. **Socket drops mid-session** (phone changes network): `WaSession` must go to `Reconnecting` and rejoin, not sit on a dead `Connected`. (Task 8)

---

### Task 0: Toolchain + `android/` scaffold + Wire codegen compiles

**Files:**
- Create: `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`, `android/gradle/libs.versions.toml`, `android/protocol/build.gradle.kts`, `android/CLAUDE.md`, `android/docs/field-notes.md`, `android/.gitignore`
- Create: `android/protocol/src/test/kotlin/app/workadventurer/protocol/WireSmokeTest.kt`

**Interfaces:**
- Produces: Gradle project with module `:protocol` whose `main` source set contains Wire-generated classes in package `app.workadventurer.proto` (`ClientToServerMessage`, `ServerToClientMessage`, `JoinRoomFrontMessage`, `PositionMessage`, `ViewportMessage`, `UserMovesMessage`, `SubMessage`, `BatchMessage`, `UserJoinedMessage`, `UserMovedMessage`, `UserLeftMessage`, `RoomJoinedMessage`, `AvailabilityStatus`, `PingMessage`, …). All later tasks import these.

- [ ] **Step 1: Install the toolchain (user action, then verify)**

There is no JDK or Gradle on this machine (`java` is only the macOS stub). Ask the user to run, in the prompt:

```
! brew install --cask temurin@17 && brew install gradle
```

Then verify (the Android SDK is at `~/Library/Android/sdk`):

```bash
java -version            # expect: openjdk version "17..."
gradle -v | head -3      # expect: Gradle 8.x
export ANDROID_HOME=$HOME/Library/Android/sdk
ls $ANDROID_HOME/platform-tools/adb
```

Expected: all succeed. If the user declines `brew`, stop and ask for an alternative; do not vendor a JDK into the repo.

- [ ] **Step 2: Write the Gradle scaffold**

`android/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "workadventure-app"
include(":protocol")
```

`android/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.wire) apply false
}
```

`android/gradle.properties`:

```
org.gradle.jvmargs=-Xmx2g
kotlin.code.style=official
android.useAndroidX=true
```

`android/gradle/libs.versions.toml`:

```toml
[versions]
kotlin = "2.0.21"
wire = "5.2.1"
okhttp = "4.12.0"
coroutines = "1.9.0"
serialization = "1.7.3"

[libraries]
wire-runtime = { module = "com.squareup.wire:wire-runtime", version.ref = "wire" }
okhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }
okhttp-mockwebserver = { module = "com.squareup.okhttp3:mockwebserver", version.ref = "okhttp" }
coroutines-core = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-core", version.ref = "coroutines" }
coroutines-test = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-test", version.ref = "coroutines" }
serialization-json = { module = "org.jetbrains.kotlinx:kotlinx-serialization-json", version.ref = "serialization" }
kotlin-test = { module = "org.jetbrains.kotlin:kotlin-test-junit", version.ref = "kotlin" }

[plugins]
kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
wire = { id = "com.squareup.wire", version.ref = "wire" }
```

`android/protocol/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.wire)
}

kotlin { jvmToolchain(17) }

// The vendored proto has no `package` line, which would put generated classes
// in the default package. Copy it with a package injected (wire encoding is
// unaffected: package only changes class names). The original in ../proto/ is
// never modified.
val protoWithPackage = tasks.register<Copy>("protoWithPackage") {
    from(rootDir.resolve("../proto/wa-1.33/messages.proto"))
    into(layout.buildDirectory.dir("wire-src"))
    filter { line ->
        if (line == "syntax = \"proto3\";") "$line\npackage app.workadventurer.proto;" else line
    }
}

wire {
    sourcePath { srcDir(layout.buildDirectory.dir("wire-src")) }
    kotlin {}
}

tasks.matching { it.name.startsWith("generate") && it.name.endsWith("Protos") }
    .configureEach { dependsOn(protoWithPackage) }

dependencies {
    api(libs.wire.runtime)
    api(libs.okhttp)
    api(libs.coroutines.core)
    implementation(libs.serialization.json)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.coroutines.test)
}
```

`android/.gitignore`:

```
.gradle/
build/
local.properties
*.iml
.idea/
```

- [ ] **Step 3: Generate the Gradle wrapper and write the smoke test**

```bash
cd android && gradle wrapper --gradle-version 8.10.2
```

`android/protocol/src/test/kotlin/app/workadventurer/protocol/WireSmokeTest.kt`:

```kotlin
package app.workadventurer.protocol

import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.proto.ClientToServerMessage
import app.workadventurer.proto.JoinRoomFrontMessage
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.ViewportMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class WireSmokeTest {
    @Test
    fun joinRoomFrontMessageRoundTrips() {
        val msg = ClientToServerMessage(
            joinRoomFrontMessage = JoinRoomFrontMessage(
                name = "hello",
                positionMessage = PositionMessage(x = 320, y = 640, direction = PositionMessage.Direction.DOWN),
                viewportMessage = ViewportMessage(left = 0, top = 0, right = 3840, bottom = 2160),
                availabilityStatus = AvailabilityStatus.ONLINE,
            ),
        )
        val decoded = ClientToServerMessage.ADAPTER.decode(ClientToServerMessage.ADAPTER.encode(msg))
        assertEquals(msg, decoded)
        assertEquals("hello", decoded.joinRoomFrontMessage!!.name)
    }
}
```

- [ ] **Step 4: Run it**

Run: `cd android && ./gradlew :protocol:test --tests '*WireSmokeTest*'`
Expected: PASS. If codegen fails on the proto (a Wire proto3 quirk, e.g. a wrapper or `google.protobuf.Value` type), fix by adjusting the Wire config or the `protoWithPackage` filter (never edit `proto/`); record exactly what was needed in `android/docs/field-notes.md`. This is G0's first learning.

- [ ] **Step 5: Write `android/CLAUDE.md` and `android/docs/field-notes.md`**

`android/CLAUDE.md` must state, verbatim: the isolation rule and graduation rules from the spec ("Repo & graduation rules"), the hygiene rules from the repo CLAUDE.md that apply (worktree avatar name, own daemon port, clean up), and "read `../docs/field-notes.md` and `../docs/livekit.md` before G3/G4". `android/docs/field-notes.md` starts with a `# Android field notes` heading and a `## G0` section header; each gate appends findings (what we learned, what contradicted the hypothesis).

- [ ] **Step 6: Commit**

```bash
git add android
git commit -m "feat(android): scaffold Gradle project, Wire codegen from proto/wa-1.33

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 1: `seq-len-v1` envelope

**Files:**
- Create: `android/protocol/src/main/kotlin/app/workadventurer/protocol/Envelope.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/EnvelopeTest.kt`

**Interfaces:**
- Produces: `object Envelope { fun wrap(seq: Long, payload: ByteArray): ByteArray; fun unwrap(frame: ByteArray): List<ByteArray> }`. Frame = `{1: seq varint, 2: payload length-delimited}`; field 2 may repeat in one frame (`src/wa-client.mjs` `_wrap` / `_unwrap`).

- [ ] **Step 1: Write the failing tests**

```kotlin
package app.workadventurer.protocol

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

class EnvelopeTest {
    private fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    @Test
    fun wrapMatchesNodeClientBytes() {
        // Node: _wrap(Buffer [0x0a,0x00]) with _outSeq=1 -> 08 01 12 02 0a 00
        assertContentEquals(bytes(0x08, 0x01, 0x12, 0x02, 0x0a, 0x00), Envelope.wrap(1, bytes(0x0a, 0x00)))
    }

    @Test
    fun unwrapReadsSeveralPayloadsInOneFrame() {
        val frame = bytes(0x08, 0x05, 0x12, 0x01, 0xaa, 0x12, 0x01, 0xbb)
        val out = Envelope.unwrap(frame)
        assertEquals(2, out.size)
        assertContentEquals(bytes(0xaa), out[0])
        assertContentEquals(bytes(0xbb), out[1])
    }

    @Test
    fun payloadLongerThan127BytesUsesMultiByteVarint() {
        val payload = ByteArray(300) { (it % 251).toByte() }
        val frame = Envelope.wrap(300, payload)
        // seq 300 = ac 02 ; len 300 = ac 02
        assertContentEquals(bytes(0x08, 0xac, 0x02, 0x12, 0xac, 0x02), frame.copyOfRange(0, 6))
        val out = Envelope.unwrap(frame)
        assertEquals(1, out.size)
        assertContentEquals(payload, out[0])
    }

    @Test
    fun unwrapSkipsUnknownFields() {
        // field 3 varint (18 01) before a normal payload
        val frame = bytes(0x18, 0x01, 0x08, 0x01, 0x12, 0x01, 0x7f)
        assertContentEquals(bytes(0x7f), Envelope.unwrap(frame).single())
    }

    @Test(expected = IllegalArgumentException::class)
    fun truncatedPayloadThrows() {
        Envelope.unwrap(bytes(0x08, 0x01, 0x12, 0x05, 0x01))
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :protocol:test --tests '*EnvelopeTest*'`
Expected: FAIL (`Envelope` unresolved).

- [ ] **Step 3: Implement**

```kotlin
package app.workadventurer.protocol

import java.io.ByteArrayOutputStream

/** The pusher's outer frame (not in the public protos): {1: seq varint, 2: inner bytes}; field 2 may repeat. */
object Envelope {
    fun wrap(seq: Long, payload: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(0x08)
        writeVarint(out, seq)
        out.write(0x12)
        writeVarint(out, payload.size.toLong())
        out.write(payload)
        return out.toByteArray()
    }

    fun unwrap(frame: ByteArray): List<ByteArray> {
        val payloads = mutableListOf<ByteArray>()
        var pos = 0
        fun varint(): Long {
            var shift = 0
            var result = 0L
            while (true) {
                require(pos < frame.size) { "truncated varint" }
                val b = frame[pos++].toInt() and 0xff
                result = result or ((b and 0x7f).toLong() shl shift)
                if (b and 0x80 == 0) return result
                shift += 7
                require(shift < 64) { "varint too long" }
            }
        }
        while (pos < frame.size) {
            val tag = varint().toInt()
            val field = tag ushr 3
            when (tag and 7) {
                0 -> varint() // seq or any unknown varint field
                2 -> {
                    val len = varint().toInt()
                    require(len >= 0 && pos + len <= frame.size) { "truncated payload" }
                    if (field == 2) payloads += frame.copyOfRange(pos, pos + len)
                    pos += len
                }
                else -> throw IllegalArgumentException("unsupported wire type ${tag and 7}")
            }
        }
        return payloads
    }

    private fun writeVarint(out: ByteArrayOutputStream, value: Long) {
        var v = value
        do {
            var b = (v and 0x7f).toInt()
            v = v ushr 7
            if (v != 0L) b = b or 0x80
            out.write(b)
        } while (v != 0L)
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :protocol:test --tests '*EnvelopeTest*'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add android/protocol
git commit -m "feat(android): seq-len-v1 frame envelope

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: wa-1.33 adapter constants, WebSocket URL, anonymous login

**Files:**
- Create: `android/protocol/src/main/kotlin/app/workadventurer/protocol/Wa133.kt`, `RoomConfig.kt`, `Login.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/LoginTest.kt`

**Interfaces:**
- Produces:
  - `data class RoomConfig(val roomUrl: String = Wa133.DEFAULT_ROOM, val pusherUrl: String = Wa133.DEFAULT_PUSHER, val name: String, val wokaId: String = Wa133.DEFAULT_WOKA, val micOn: Boolean = false)`
  - `object Wa133 { const val DEFAULT_ROOM; const val DEFAULT_PUSHER; const val DEFAULT_WOKA; val API_VERSION_HASHES: List<String>; const val ANONYM_LOGIN = "/anonymLogin"; const val MAP = "/map" }`
  - `data class Login(val authToken: String, val userUuid: String)`
  - `suspend fun anonymLogin(http: OkHttpClient, cfg: RoomConfig): Login` (throws `IOException("anonymLogin failed: <code> <body>")`)
  - `fun wsUrl(cfg: RoomConfig, tabId: String): HttpUrl` (scheme http(s); OkHttp upgrades it)

- [ ] **Step 1: Write the failing tests** (mirrors `_anonymLogin` / `_wsUrl`)

```kotlin
package app.workadventurer.protocol

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class LoginTest {
    @Test
    fun anonymLoginPostsEmptyJsonAndParsesToken() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"authToken":"tok123","userUuid":"u-1","extra":1}"""))
            server.start()
            val cfg = RoomConfig(pusherUrl = server.url("/").toString().trimEnd('/'), name = "t")
            val login = anonymLogin(OkHttpClient(), cfg)
            assertEquals(Login("tok123", "u-1"), login)
            val req = server.takeRequest()
            assertEquals("POST", req.method)
            assertEquals("/anonymLogin", req.path)
            assertEquals("{}", req.body.readUtf8())
        }
    }

    @Test
    fun anonymLoginFailureIncludesStatusAndBody() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503).setBody("nope"))
            server.start()
            val cfg = RoomConfig(pusherUrl = server.url("/").toString().trimEnd('/'), name = "t")
            val e = assertFailsWith<IOException> { anonymLogin(OkHttpClient(), cfg) }
            assertEquals("anonymLogin failed: 503 nope", e.message)
        }
    }

    @Test
    fun wsUrlCarriesRoomWokaVersionAndMediaState() {
        val cfg = RoomConfig(name = "n", micOn = false)
        val u = wsUrl(cfg, tabId = "abc123abc123")
        assertEquals("/ws/room", u.encodedPath)
        assertEquals(Wa133.DEFAULT_ROOM, u.queryParameter("roomId"))
        assertEquals(listOf(Wa133.DEFAULT_WOKA), u.queryParameterValues("characterTextureIds"))
        assertEquals("05489a87", u.queryParameter("version"))
        assertEquals("false", u.queryParameter("microphoneState"))
        assertEquals("false", u.queryParameter("cameraState"))
        assertEquals("abc123abc123", u.queryParameter("tabId"))
        assertEquals("pusher.workadventu.re", u.host)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :protocol:test --tests '*LoginTest*'`
Expected: FAIL (unresolved references).

- [ ] **Step 3: Implement**

`Wa133.kt`:

```kotlin
package app.workadventurer.protocol

/** Frozen constants for WorkAdventure prod (v1.33.x). Mirrors src/adapters/wa-1.33.mjs. */
object Wa133 {
    const val DEFAULT_PUSHER = "https://pusher.workadventu.re"
    const val DEFAULT_ROOM = "https://play.workadventu.re/@/afrolabs/afrolabs/open-space"
    const val DEFAULT_WOKA = "506a3a64-47a9-4587-b19b-2d1eb13f9790"
    /** Index 0 is what we send; newest first. A patch release may shift the hash: append, don't fork. */
    val API_VERSION_HASHES = listOf("05489a87", "bfd20fc4")
    const val ANONYM_LOGIN = "/anonymLogin"
    const val MAP = "/map"
}
```

`RoomConfig.kt`:

```kotlin
package app.workadventurer.protocol

data class RoomConfig(
    val roomUrl: String = Wa133.DEFAULT_ROOM,
    val pusherUrl: String = Wa133.DEFAULT_PUSHER,
    val name: String,
    val wokaId: String = Wa133.DEFAULT_WOKA,
    val micOn: Boolean = false,
)
```

`Login.kt`:

```kotlin
package app.workadventurer.protocol

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

data class Login(val authToken: String, val userUuid: String)

suspend fun anonymLogin(http: OkHttpClient, cfg: RoomConfig): Login = withContext(Dispatchers.IO) {
    val req = Request.Builder()
        .url(cfg.pusherUrl + Wa133.ANONYM_LOGIN)
        .post("{}".toRequestBody("application/json".toMediaTypeOrNull()))
        .build()
    http.newCall(req).execute().use { res ->
        val body = res.body?.string().orEmpty()
        if (!res.isSuccessful) throw IOException("anonymLogin failed: ${res.code} $body")
        val o = Json.parseToJsonElement(body).jsonObject
        Login(o.getValue("authToken").jsonPrimitive.content, o["userUuid"]?.jsonPrimitive?.content.orEmpty())
    }
}

fun wsUrl(cfg: RoomConfig, tabId: String): HttpUrl =
    cfg.pusherUrl.toHttpUrl().newBuilder()
        .encodedPath("/ws/room")
        .addQueryParameter("roomId", cfg.roomUrl)
        .addQueryParameter("characterTextureIds", cfg.wokaId)
        .addQueryParameter("version", Wa133.API_VERSION_HASHES[0])
        .addQueryParameter("roomName", "")
        .addQueryParameter("cameraState", "false")
        .addQueryParameter("microphoneState", cfg.micOn.toString())
        .addQueryParameter("screenSharingState", "false")
        .addQueryParameter("chatID", "")
        .addQueryParameter("tabId", tabId)
        .build()
```

Add `import okhttp3.MediaType.Companion.toMediaTypeOrNull` to `Login.kt`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :protocol:test --tests '*LoginTest*'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add android/protocol
git commit -m "feat(android): wa-1.33 constants, anonymLogin, ws url

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Map areas + spawn point

**Files:**
- Create: `android/protocol/src/main/kotlin/app/workadventurer/protocol/Areas.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/AreasTest.kt`

**Interfaces:**
- Consumes: `RoomConfig`, `Wa133.MAP` (Task 2).
- Produces:
  - `data class Area(val id: String?, val name: String, val x: Int, val y: Int, val w: Int, val h: Int, val propertyTypes: Set<String>, val isStart: Boolean, val isDefaultStart: Boolean)` with `fun contains(px: Int, py: Int): Boolean`
  - `data class Spawn(val x: Int, val y: Int, val area: String?)`
  - `suspend fun loadAreas(http: OkHttpClient, cfg: RoomConfig): List<Area>` (never throws; `[]` on any failure)
  - `fun pickSpawn(areas: List<Area>, rnd: kotlin.random.Random = Random.Default): Spawn` (falls back to `Spawn(320, 320, null)`)
  - `fun parseWam(json: String): List<Area>` (pure; used by the tests)

Mirrors `_loadAreas` + `_wamSpawnPoint` (prefer an area with a `start` property; prefer `isDefault`; random point inside with 12px margin). The CLI additionally nudges off blocked tiles using `map-nav`; that arrives with `:nav` in G2, so it's deliberately absent here (note it in G0 findings if the avatar spawns inside a wall).

- [ ] **Step 1: Write the failing tests**

```kotlin
package app.workadventurer.protocol

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class AreasTest {
    private val wam = """
      {"areas":[
        {"id":"a1","name":"Fire pit","x":100,"y":100,"width":200,"height":100,
         "properties":[{"type":"livekitRoomProperty","roomName":"pit"}]},
        {"id":"s1","name":"","x":1000,"y":1000,"width":64,"height":64,
         "properties":[{"type":"start"}]},
        {"id":"s2","name":"Main start","x":2000,"y":2000,"width":128,"height":128,
         "properties":[{"type":"start","isDefault":true}]}
      ]}"""

    @Test
    fun parseWamReadsBoundsNamesAndStartFlags() {
        val areas = parseWam(wam)
        assertEquals(3, areas.size)
        val pit = areas[0]
        assertEquals("Fire pit", pit.name)
        assertTrue(pit.contains(150, 150))
        assertTrue(!pit.contains(50, 150))
        assertEquals("(unnamed)", areas[1].name)
        assertTrue(areas[2].isStart && areas[2].isDefaultStart)
    }

    @Test
    fun pickSpawnPrefersDefaultStartAndStaysInsideWithMargin() {
        repeat(50) { i ->
            val s = pickSpawn(parseWam(wam), Random(i))
            assertEquals("Main start", s.area)
            assertTrue(s.x in 2012..2116 && s.y in 2012..2116, "spawn ${s.x},${s.y}")
        }
    }

    @Test
    fun pickSpawnFallsBackWhenNoStartArea() {
        assertEquals(Spawn(320, 320, null), pickSpawn(emptyList()))
        assertEquals(Spawn(320, 320, null), pickSpawn(parseWam("""{"areas":[]}""")))
    }

    @Test
    fun loadAreasSwallowsFetchFailures() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(500))
            server.start()
            val cfg = RoomConfig(pusherUrl = server.url("/").toString().trimEnd('/'), name = "t")
            assertEquals(emptyList(), loadAreas(OkHttpClient(), cfg))
        }
    }

    @Test
    fun loadAreasFollowsMapToWam() = runTest {
        MockWebServer().use { server ->
            server.start()
            val base = server.url("/").toString().trimEnd('/')
            server.enqueue(MockResponse().setBody("""{"wamUrl":"$base/the.wam"}"""))
            server.enqueue(MockResponse().setBody(wam))
            val areas = loadAreas(OkHttpClient(), RoomConfig(pusherUrl = base, name = "t"))
            assertEquals(3, areas.size)
            val first = server.takeRequest()
            assertNotNull(first.path)
            assertTrue(first.path!!.startsWith("/map?playUri="))
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :protocol:test --tests '*AreasTest*'`
Expected: FAIL (unresolved references).

- [ ] **Step 3: Implement**

```kotlin
package app.workadventurer.protocol

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import kotlin.random.Random

data class Area(
    val id: String?,
    val name: String,
    val x: Int,
    val y: Int,
    val w: Int,
    val h: Int,
    val propertyTypes: Set<String>,
    val isStart: Boolean,
    val isDefaultStart: Boolean,
) {
    fun contains(px: Int, py: Int) = px in x..(x + w) && py in y..(y + h)
}

data class Spawn(val x: Int, val y: Int, val area: String?)

private const val SPAWN_MARGIN = 12

fun parseWam(json: String): List<Area> {
    val root = Json.parseToJsonElement(json).jsonObject
    val areas = (root["areas"] as? JsonArray) ?: return emptyList()
    return areas.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val props = (o["properties"] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
        val start = props.filter { it["type"]?.jsonPrimitive?.contentOrNull == "start" }
        Area(
            id = o["id"]?.jsonPrimitive?.contentOrNull,
            name = o["name"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() } ?: "(unnamed)",
            x = o["x"]?.jsonPrimitive?.intOrNull ?: return@mapNotNull null,
            y = o["y"]?.jsonPrimitive?.intOrNull ?: return@mapNotNull null,
            w = o["width"]?.jsonPrimitive?.intOrNull ?: return@mapNotNull null,
            h = o["height"]?.jsonPrimitive?.intOrNull ?: return@mapNotNull null,
            propertyTypes = props.mapNotNull { it["type"]?.jsonPrimitive?.contentOrNull }.toSet(),
            isStart = start.isNotEmpty(),
            isDefaultStart = start.any { it["isDefault"]?.jsonPrimitive?.booleanOrNull == true },
        )
    }
}

/** Best-effort: any failure yields an empty list (join must still work without areas). */
suspend fun loadAreas(http: OkHttpClient, cfg: RoomConfig): List<Area> = withContext(Dispatchers.IO) {
    try {
        val mapUrl = (cfg.pusherUrl + Wa133.MAP).toHttpUrl().newBuilder()
            .addQueryParameter("playUri", cfg.roomUrl).build()
        fun get(url: String): String = http.newCall(Request.Builder().url(url).build()).execute().use {
            check(it.isSuccessful) { "HTTP ${it.code}" }
            it.body!!.string()
        }
        val wamUrl = Json.parseToJsonElement(get(mapUrl.toString())).jsonObject["wamUrl"]
            ?.jsonPrimitive?.contentOrNull ?: return@withContext emptyList()
        parseWam(get(wamUrl))
    } catch (e: Exception) {
        emptyList()
    }
}

fun pickSpawn(areas: List<Area>, rnd: Random = Random.Default): Spawn {
    val starts = areas.filter { it.isStart }
    val a = starts.firstOrNull { it.isDefaultStart } ?: starts.firstOrNull()
        ?: return Spawn(320, 320, null)
    val x = a.x + SPAWN_MARGIN + rnd.nextInt(maxOf(1, a.w - 2 * SPAWN_MARGIN))
    val y = a.y + SPAWN_MARGIN + rnd.nextInt(maxOf(1, a.h - 2 * SPAWN_MARGIN))
    return Spawn(x, y, a.name)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :protocol:test --tests '*AreasTest*'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add android/protocol
git commit -m "feat(android): map areas + .wam start-area spawn

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `RoomState` reducer

**Files:**
- Create: `android/protocol/src/main/kotlin/app/workadventurer/protocol/RoomState.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/RoomStateTest.kt`

**Interfaces:**
- Consumes: Wire `SubMessage`, `UserJoinedMessage`, `UserMovedMessage`, `UserLeftMessage`, `GroupUpdateMessage`, `GroupDeleteMessage`, `PositionMessage` (Task 0).
- Produces:
  - `data class Player(val userId: Int, val name: String, val uuid: String, val x: Int, val y: Int, val direction: PositionMessage.Direction)`
  - `class RoomState { val players: StateFlow<Map<Int, Player>>; val myUserId: StateFlow<Int?>; val groupId: StateFlow<Int?>; var areas: List<Area>; fun setMyUserId(id: Int); fun setMyPosition(x: Int, y: Int); fun myPosition(): Pair<Int,Int>; fun currentAreas(): List<Area>; fun applySub(sub: SubMessage); fun clear() }`

Mirrors `_handleSub`: `userJoinedMessage`, `userMovedMessage`, `userLeftMessage`, `groupUpdateMessage`, `groupDeleteMessage` (only the group we're a member of is tracked). Ping is **not** handled here (needs to send; Task 5).

- [ ] **Step 1: Write the failing tests**

```kotlin
package app.workadventurer.protocol

import app.workadventurer.proto.GroupDeleteMessage
import app.workadventurer.proto.GroupUpdateMessage
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.SubMessage
import app.workadventurer.proto.UserJoinedMessage
import app.workadventurer.proto.UserLeftMessage
import app.workadventurer.proto.UserMovedMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class RoomStateTest {
    private fun join(id: Int, name: String, x: Int = 10, y: Int = 20) = SubMessage(
        userJoinedMessage = UserJoinedMessage(
            userId = id, name = name, userUuid = "uuid-$id",
            position = PositionMessage(x = x, y = y, direction = PositionMessage.Direction.LEFT),
        ),
    )

    @Test
    fun joinMoveLeaveLifecycle() {
        val s = RoomState()
        s.applySub(join(5, "Ada"))
        assertEquals("Ada", s.players.value.getValue(5).name)
        s.applySub(SubMessage(userMovedMessage = UserMovedMessage(userId = 5, position = PositionMessage(x = 99, y = 98, direction = PositionMessage.Direction.UP))))
        assertEquals(99, s.players.value.getValue(5).x)
        assertEquals(PositionMessage.Direction.UP, s.players.value.getValue(5).direction)
        s.applySub(SubMessage(userLeftMessage = UserLeftMessage(userId = 5)))
        assertEquals(emptyMap(), s.players.value)
    }

    @Test
    fun moveForUnknownUserIsIgnored() {
        val s = RoomState()
        s.applySub(SubMessage(userMovedMessage = UserMovedMessage(userId = 404, position = PositionMessage(x = 1, y = 1))))
        assertEquals(emptyMap(), s.players.value)
    }

    @Test
    fun duplicateJoinReplacesInsteadOfDuplicating() {
        val s = RoomState()
        s.applySub(join(1, "Old"))
        s.applySub(join(1, "New"))
        assertEquals(1, s.players.value.size)
        assertEquals("New", s.players.value.getValue(1).name)
    }

    @Test
    fun emptyAndUnicodeNamesAreKept() {
        val s = RoomState()
        s.applySub(join(1, ""))
        s.applySub(join(2, "Zoë 🦊"))
        assertEquals("", s.players.value.getValue(1).name)
        assertEquals("Zoë 🦊", s.players.value.getValue(2).name)
    }

    @Test
    fun onlyTracksTheGroupWeAreIn() {
        val s = RoomState()
        s.setMyUserId(7)
        s.applySub(SubMessage(groupUpdateMessage = GroupUpdateMessage(groupId = 1, userIds = listOf(2, 3))))
        assertNull(s.groupId.value)
        s.applySub(SubMessage(groupUpdateMessage = GroupUpdateMessage(groupId = 2, userIds = listOf(7, 3))))
        assertEquals(2, s.groupId.value)
        s.applySub(SubMessage(groupDeleteMessage = GroupDeleteMessage(groupId = 2)))
        assertNull(s.groupId.value)
    }

    @Test
    fun clearResetsPlayersAndGroupButNotAreas() {
        val s = RoomState()
        s.areas = listOf(Area("a", "A", 0, 0, 10, 10, emptySet(), false, false))
        s.setMyUserId(1)
        s.applySub(join(2, "x"))
        s.clear()
        assertEquals(emptyMap(), s.players.value)
        assertNull(s.myUserId.value)
        assertEquals(1, s.areas.size)
    }

    @Test
    fun currentAreasFollowMyPosition() {
        val s = RoomState()
        s.areas = listOf(Area("a", "A", 0, 0, 100, 100, emptySet(), false, false), Area("b", "B", 500, 500, 10, 10, emptySet(), false, false))
        s.setMyPosition(50, 50)
        assertEquals(listOf("A"), s.currentAreas().map { it.name })
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :protocol:test --tests '*RoomStateTest*'`
Expected: FAIL (unresolved `RoomState`).

- [ ] **Step 3: Implement**

```kotlin
package app.workadventurer.protocol

import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.SubMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class Player(
    val userId: Int,
    val name: String,
    val uuid: String,
    val x: Int,
    val y: Int,
    val direction: PositionMessage.Direction,
)

/** Reduces server sub-messages into observable room state. Mirrors WorkAdventureClient._handleSub. */
class RoomState {
    private val _players = MutableStateFlow<Map<Int, Player>>(emptyMap())
    private val _myUserId = MutableStateFlow<Int?>(null)
    private val _groupId = MutableStateFlow<Int?>(null)
    @Volatile private var pos = 0 to 0

    val players: StateFlow<Map<Int, Player>> = _players.asStateFlow()
    val myUserId: StateFlow<Int?> = _myUserId.asStateFlow()
    val groupId: StateFlow<Int?> = _groupId.asStateFlow()
    @Volatile var areas: List<Area> = emptyList()

    fun setMyUserId(id: Int) { _myUserId.value = id }
    fun setMyPosition(x: Int, y: Int) { pos = x to y }
    fun myPosition(): Pair<Int, Int> = pos
    fun currentAreas(): List<Area> = areas.filter { it.contains(pos.first, pos.second) }

    fun applySub(sub: SubMessage) {
        sub.userJoinedMessage?.let { u ->
            _players.update {
                it + (u.userId to Player(
                    userId = u.userId,
                    name = u.name,
                    uuid = u.userUuid,
                    x = u.position?.x ?: 0,
                    y = u.position?.y ?: 0,
                    direction = u.position?.direction ?: PositionMessage.Direction.DOWN,
                ))
            }
        }
        sub.userMovedMessage?.let { m ->
            val p = m.position ?: return@let
            _players.update { cur ->
                val existing = cur[m.userId] ?: return@update cur // unknown user: ignore
                cur + (m.userId to existing.copy(x = p.x, y = p.y, direction = p.direction))
            }
        }
        sub.userLeftMessage?.let { l -> _players.update { it - l.userId } }
        sub.groupUpdateMessage?.let { g ->
            val mine = _myUserId.value?.let { it in g.userIds } ?: false
            if (mine) _groupId.value = g.groupId
            else if (_groupId.value == g.groupId) _groupId.value = null
        }
        sub.groupDeleteMessage?.let { g -> if (_groupId.value == g.groupId) _groupId.value = null }
    }

    /** Reset live room state (players/group/identity) for a reconnect. Areas are per-room and kept. */
    fun clear() {
        _players.value = emptyMap()
        _myUserId.value = null
        _groupId.value = null
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :protocol:test --tests '*RoomStateTest*'`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add android/protocol
git commit -m "feat(android): RoomState reducer for players/groups

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `PusherConnection` (OkHttp WebSocket handshake + keepalive)

**Files:**
- Create: `android/protocol/src/main/kotlin/app/workadventurer/protocol/PusherConnection.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/PusherConnectionTest.kt`

**Interfaces:**
- Consumes: `RoomConfig`, `Login`, `anonymLogin`, `wsUrl` (Task 2); `loadAreas`, `pickSpawn`, `Spawn` (Task 3); `RoomState` (Task 4); `Envelope` (Task 1); Wire types (Task 0).
- Produces:

```kotlin
class JoinFailed(message: String) : Exception(message)
data class Closed(val code: Int, val reason: String)

class PusherConnection(
    private val http: OkHttpClient,
    private val cfg: RoomConfig,
    val state: RoomState = RoomState(),
    private val keepAliveMs: Long = 5_000,
) {
    val closed: Deferred<Closed>          // completes when the socket closes/fails after (or before) join
    val log: SharedFlow<String>           // human-readable events ("socket open", "joined as userId 7", ...)
    suspend fun connect()                 // login -> areas -> spawn -> ws; returns after roomJoinedMessage; throws JoinFailed
    fun close()
}
```

Behaviour (mirrors `connect` / `_handle` / `_handleSub` / `_startKeepAlive`): token as the WebSocket subprotocol (`Sec-WebSocket-Protocol: <token>`) plus `Origin: https://play.workadventu.re`; on `roomConnectedMessage` send `joinRoomFrontMessage{name, position(spawn, DOWN, moving=false), viewport(±1920×±1080 around spawn, clamped ≥0), availabilityStatus=ONLINE}`; on `roomJoinedMessage` record `currentUserId`, set position, start keepalive (`userMovesMessage` every `keepAliveMs`, same position + viewport) and complete `connect()`; `batchMessage.payload[].pingMessage` → reply `pingMessage`; other sub-messages → `state.applySub`. `errorScreenMessage` / `invalidCharacterTextureMessage` / `tokenExpiredMessage` / close-before-join → `connect()` throws `JoinFailed`. Outbound frames use a per-connection seq starting at 1.

- [ ] **Step 1: Write the failing tests**

A MockWebServer plays the pusher: `/anonymLogin`, `/map` (returns `{}`), and a WebSocket upgrade. Helper `s2c(...)` encodes a `ServerToClientMessage` and wraps it with `Envelope.wrap`.

```kotlin
package app.workadventurer.protocol

import app.workadventurer.proto.BatchMessage
import app.workadventurer.proto.ClientToServerMessage
import app.workadventurer.proto.ErrorScreenMessage
import app.workadventurer.proto.PingMessage
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.RoomConnectedMessage
import app.workadventurer.proto.RoomJoinedMessage
import app.workadventurer.proto.ServerToClientMessage
import app.workadventurer.proto.SubMessage
import app.workadventurer.proto.UserJoinedMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class PusherConnectionTest {
    private fun s2c(m: ServerToClientMessage): ByteString =
        Envelope.wrap(1, ServerToClientMessage.ADAPTER.encode(m)).toByteString()

    private class Fake(val onOpen: (WebSocket) -> Unit, val onFrame: (WebSocket, ClientToServerMessage) -> Unit) {
        val received = LinkedBlockingQueue<ClientToServerMessage>()
        var upgradeRequest: RecordedRequest? = null
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onOpen(webSocket)
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val msg = ClientToServerMessage.ADAPTER.decode(Envelope.unwrap(bytes.toByteArray()).single())
                received.add(msg)
                onFrame(webSocket, msg)
            }
        }
    }

    private fun server(fake: Fake): MockWebServer {
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path!!.startsWith("/anonymLogin") -> MockResponse().setBody("""{"authToken":"TOK","userUuid":"me"}""")
                request.path!!.startsWith("/map") -> MockResponse().setBody("{}")
                request.path!!.startsWith("/ws/room") -> {
                    fake.upgradeRequest = request
                    MockResponse().withWebSocketUpgrade(fake.listener)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        s.start()
        return s
    }

    private fun cfg(s: MockWebServer) =
        RoomConfig(pusherUrl = s.url("/").toString().trimEnd('/'), name = "tester")

    @Test
    fun handshakeJoinsAndTracksPlayers() = runBlocking {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))) },
            onFrame = { ws, msg ->
                if (msg.joinRoomFrontMessage != null) {
                    ws.send(s2c(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 7))))
                    ws.send(s2c(ServerToClientMessage(batchMessage = BatchMessage(payload = listOf(
                        SubMessage(userJoinedMessage = UserJoinedMessage(userId = 9, name = "Ada", userUuid = "u9",
                            position = PositionMessage(x = 5, y = 6))),
                    )))))
                }
            },
        )
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 50)
            withTimeout(5_000) { conn.connect() }
            assertEquals(7, conn.state.myUserId.value)
            // token as websocket subprotocol, Origin header present
            assertEquals("TOK", fake.upgradeRequest!!.getHeader("Sec-WebSocket-Protocol"))
            assertEquals("https://play.workadventu.re", fake.upgradeRequest!!.getHeader("Origin"))
            val join = fake.received.poll(2, TimeUnit.SECONDS)!!.joinRoomFrontMessage!!
            assertEquals("tester", join.name)
            assertEquals(PositionMessage.Direction.DOWN, join.positionMessage!!.direction)
            // spawn fallback when /map has no wamUrl
            assertEquals(320, join.positionMessage!!.x)
            withTimeout(5_000) { while (conn.state.players.value[9] == null) kotlinx.coroutines.delay(10) }
            assertEquals("Ada", conn.state.players.value.getValue(9).name)
            // keepalive emits userMovesMessage
            val move = generateSequence { fake.received.poll(2, TimeUnit.SECONDS) }
                .first { it.userMovesMessage != null }.userMovesMessage!!
            assertEquals(320, move.position!!.x)
            conn.close()
        }
    }

    @Test
    fun answersPingWithPing() = runBlocking {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))) },
            onFrame = { ws, msg ->
                if (msg.joinRoomFrontMessage != null) {
                    ws.send(s2c(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 1))))
                    ws.send(s2c(ServerToClientMessage(batchMessage = BatchMessage(payload = listOf(SubMessage(pingMessage = PingMessage()))))))
                }
            },
        )
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            val pong = generateSequence { fake.received.poll(2, TimeUnit.SECONDS) }
                .first { it.pingMessage != null }
            assertNotNull(pong.pingMessage)
            conn.close()
        }
    }

    @Test
    fun errorScreenBeforeJoinFailsConnect() = runBlocking {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(errorScreenMessage = ErrorScreenMessage(title = "Nope", details = "full")))) },
            onFrame = { _, _ -> },
        )
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s))
            val e = assertFailsWith<JoinFailed> { withTimeout(5_000) { conn.connect() } }
            assertTrue(e.message!!.contains("Nope"), e.message)
        }
    }

    @Test
    fun closeBeforeJoinFailsConnectInsteadOfHanging() = runBlocking {
        val fake = Fake(onOpen = { ws -> ws.close(1008, "bad version") }, onFrame = { _, _ -> })
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s))
            val e = assertFailsWith<JoinFailed> { withTimeout(5_000) { conn.connect() } }
            assertTrue(e.message!!.contains("1008"), e.message)
        }
    }

    @Test
    fun closedCompletesWhenServerDropsAfterJoin() = runBlocking {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))) },
            onFrame = { ws, msg ->
                if (msg.joinRoomFrontMessage != null) {
                    ws.send(s2c(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 1))))
                    ws.close(1001, "going away")
                }
            },
        )
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            val c = withTimeout(5_000) { conn.closed.await() }
            assertEquals(1001, c.code)
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :protocol:test --tests '*PusherConnectionTest*'`
Expected: FAIL (unresolved `PusherConnection`).

- [ ] **Step 3: Implement**

```kotlin
package app.workadventurer.protocol

import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.proto.ClientToServerMessage
import app.workadventurer.proto.JoinRoomFrontMessage
import app.workadventurer.proto.PingMessage
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.ServerToClientMessage
import app.workadventurer.proto.UserMovesMessage
import app.workadventurer.proto.ViewportMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

class JoinFailed(message: String) : Exception(message)
data class Closed(val code: Int, val reason: String)

/** One live pusher socket for one room. Mirrors WorkAdventureClient.connect/_handle/_startKeepAlive. */
class PusherConnection(
    private val http: OkHttpClient,
    private val cfg: RoomConfig,
    val state: RoomState = RoomState(),
    private val keepAliveMs: Long = 5_000,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val seq = AtomicLong(1)
    private val joined = CompletableDeferred<Unit>()
    private val _closed = CompletableDeferred<Closed>()
    private val _log = MutableSharedFlow<String>(extraBufferCapacity = 64)
    private var ws: WebSocket? = null
    private var keepAlive: Job? = null
    private var spawn = Spawn(320, 320, null)

    val closed: Deferred<Closed> = _closed
    val log: SharedFlow<String> = _log.asSharedFlow()

    suspend fun connect() {
        val login = anonymLogin(http, cfg)
        _log.tryEmit("anonymLogin ok (uuid ${login.userUuid})")
        val areas = loadAreas(http, cfg)
        state.areas = areas
        spawn = pickSpawn(areas)
        state.setMyPosition(spawn.x, spawn.y)
        _log.tryEmit("loaded ${areas.size} map areas; spawn ${spawn.x},${spawn.y}${spawn.area?.let { " in \"$it\"" } ?: ""}")

        val req = Request.Builder()
            .url(wsUrl(cfg, UUID.randomUUID().toString().take(12)))
            .header("Sec-WebSocket-Protocol", login.authToken) // JWT rides as the subprotocol
            .header("Origin", "https://play.workadventu.re")
            .build()
        ws = http.newWebSocket(req, listener)
        joined.await()
    }

    fun close() {
        keepAlive?.cancel()
        ws?.close(1000, "bye")
        scope.cancel()
    }

    private fun send(m: ClientToServerMessage) {
        ws?.send(Envelope.wrap(seq.getAndIncrement(), ClientToServerMessage.ADAPTER.encode(m)).toByteString())
    }

    private fun viewport(): ViewportMessage {
        val (x, y) = state.myPosition()
        return ViewportMessage(
            left = maxOf(0, x - 1920), top = maxOf(0, y - 1080), right = x + 1920, bottom = y + 1080,
        )
    }

    private fun position(moving: Boolean): PositionMessage {
        val (x, y) = state.myPosition()
        return PositionMessage(x = x, y = y, direction = PositionMessage.Direction.DOWN, moving = moving)
    }

    private fun fail(reason: String) {
        if (!joined.isCompleted) joined.completeExceptionally(JoinFailed(reason))
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            _log.tryEmit("socket open; waiting for roomConnectedMessage")
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val payloads = try { Envelope.unwrap(bytes.toByteArray()) } catch (e: Exception) {
                _log.tryEmit("unwrap error: ${e.message}"); return
            }
            for (p in payloads) {
                val msg = try { ServerToClientMessage.ADAPTER.decode(p) } catch (e: Exception) {
                    _log.tryEmit("decode error: ${e.message}"); continue
                }
                handle(msg)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(code, reason)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            finish(response?.code ?: -1, t.message ?: t.javaClass.simpleName)
    }

    private fun finish(code: Int, reason: String) {
        keepAlive?.cancel()
        fail("closed before join: $code $reason")
        _closed.complete(Closed(code, reason))
    }

    private fun handle(m: ServerToClientMessage) {
        m.batchMessage?.let { b ->
            for (sub in b.payload) {
                if (sub.pingMessage != null) send(ClientToServerMessage(pingMessage = PingMessage()))
                else state.applySub(sub)
            }
            return
        }
        if (m.roomConnectedMessage != null) {
            _log.tryEmit("roomConnectedMessage received; sending joinRoomFrontMessage")
            send(ClientToServerMessage(joinRoomFrontMessage = JoinRoomFrontMessage(
                name = cfg.name,
                positionMessage = position(false),
                viewportMessage = viewport(),
                availabilityStatus = AvailabilityStatus.ONLINE,
            )))
            return
        }
        m.roomJoinedMessage?.let { r ->
            state.setMyUserId(r.currentUserId)
            _log.tryEmit("joined room as userId ${r.currentUserId}")
            startKeepAlive()
            joined.complete(Unit)
            return
        }
        m.errorScreenMessage?.let { fail("server error screen: ${it.title} / ${it.details}"); return }
        if (m.invalidCharacterTextureMessage != null) { fail("invalid character texture"); return }
        if (m.tokenExpiredMessage != null) { fail("token expired"); return }
        m.errorMessage?.let { _log.tryEmit("errorMessage: ${it.message}") }
    }

    private fun startKeepAlive() {
        keepAlive?.cancel()
        keepAlive = scope.launch {
            while (true) {
                delay(keepAliveMs)
                send(ClientToServerMessage(userMovesMessage = UserMovesMessage(position = position(false), viewport = viewport())))
            }
        }
    }
}
```

If Wire names differ from the JS field names (e.g. `ErrorScreenMessage` field is `details` vs `subtitle`), the compiler will say so: read `proto/wa-1.33/messages.proto` for the real names and fix; record any mismatch in field notes.

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :protocol:test --tests '*PusherConnectionTest*'`
Expected: PASS (5 tests). If `closeBeforeJoin…` hangs, `onClosed`/`onFailure` aren't completing `joined`; fix `finish` rather than loosening the test.

- [ ] **Step 5: Commit**

```bash
git add android/protocol
git commit -m "feat(android): PusherConnection (handshake, keepalive, ping)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `:wa-cli`, the G0 live check

**Files:**
- Modify: `android/settings.gradle.kts` (add `include(":wa-cli")`)
- Create: `android/wa-cli/build.gradle.kts`, `android/wa-cli/src/main/kotlin/app/workadventurer/cli/Main.kt`
- Modify: `android/docs/field-notes.md` (G0 findings)

**Interfaces:**
- Consumes: `PusherConnection`, `RoomConfig`, `Player`, `Area` (Tasks 2-5).
- Produces: `./gradlew :wa-cli:run --args="--name <avatar> [--room URL] [--pusher URL] [--seconds N]"`. Prints the log lines, then every 5 s the player list and which area(s) we're in, for `--seconds` (default 30), then closes.

- [ ] **Step 1: Add the module**

`android/wa-cli/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}
kotlin { jvmToolchain(17) }
application { mainClass.set("app.workadventurer.cli.MainKt") }
dependencies { implementation(project(":protocol")) }
```

`Main.kt`:

```kotlin
package app.workadventurer.cli

import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import app.workadventurer.protocol.Wa133
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import kotlin.system.exitProcess

fun main(args: Array<String>) = runBlocking {
    fun opt(flag: String) = args.indexOf(flag).takeIf { it >= 0 }?.let { args.getOrNull(it + 1) }
    val name = opt("--name") ?: run {
        System.err.println("usage: --name <avatar> [--room URL] [--pusher URL] [--seconds N]\n(name the avatar after your worktree, never bare 'claude')")
        exitProcess(2)
    }
    val cfg = RoomConfig(
        name = name,
        roomUrl = opt("--room") ?: Wa133.DEFAULT_ROOM,
        pusherUrl = opt("--pusher") ?: Wa133.DEFAULT_PUSHER,
    )
    val seconds = opt("--seconds")?.toInt() ?: 30
    val conn = PusherConnection(OkHttpClient(), cfg)
    val logJob = launch { conn.log.collect { println("· $it") } }
    try {
        conn.connect()
    } catch (e: Exception) {
        System.err.println("join failed: ${e.message}")
        exitProcess(1)
    }
    repeat(seconds / 5) {
        delay(5_000)
        val players = conn.state.players.value.values.sortedBy { it.name.lowercase() }
        val areas = conn.state.currentAreas().joinToString { it.name }
        println("— ${players.size} players; in areas: ${areas.ifEmpty { "(none)" }}")
        players.forEach { println("   ${it.name.ifEmpty { "(no name)" }}  @ ${it.x},${it.y}") }
        if (conn.closed.isCompleted) { println("closed: ${conn.closed.await()}"); exitProcess(1) }
    }
    conn.close()
    logJob.cancel()
    exitProcess(0)
}
```

- [ ] **Step 2: Build and run the whole suite**

Run: `cd android && ./gradlew test :wa-cli:installDist`
Expected: all unit tests pass, build succeeds.

- [ ] **Step 3: G0 live check**

Pick a free state first: `lsof -iTCP -sTCP:LISTEN -P | grep node`. Use the worktree-derived avatar name (e.g. `android-g0`). Ask the user to have a browser avatar in the same room (afrolabs), then:

```bash
cd android && ./gradlew :wa-cli:run --args="--name android-g0 --seconds 30"
```

Expected: log shows `anonymLogin ok`, `loaded N map areas`, `joined room as userId …`; the player list includes the user's browser avatar by name and updates as they move; the user confirms **android-g0 is visible in their browser** at the spawn area. Done = G0's question answered. If it fails, diagnose with `systematic-debugging` against `src/wa-client.mjs` (most likely suspects: `Sec-WebSocket-Protocol` subprotocol handling in OkHttp, the `Origin` header, the Wire package injection). Never mark G0 done on unit tests alone.

- [ ] **Step 4: Write G0 findings**

Append to `android/docs/field-notes.md` under `## G0`: result, exact versions that worked, anything that contradicted the architecture hypothesis (e.g. subprotocol handling, spawn inside a wall → needs `:nav`'s nudge), and any Wire quirks.

- [ ] **Step 5: Commit and report**

```bash
git add android
git commit -m "feat(android): wa-cli live check for G0 + findings

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Stop and report G0 results to the user before starting G1; update the spec if the findings changed the architecture.

---

### Task 7: `WaSession` (state, `dispatch(Command)`, reconnect)

> Begins G1. Lives in `:app` per the spec but is plain Kotlin (no Android imports) so it unit-tests on the JVM. The `:app` module is created in Task 9; until then this task adds the `:app` Gradle module skeleton with only these JVM sources, to keep every task independently testable.

**Files:**
- Modify: `android/settings.gradle.kts` (add `include(":app")`), `android/gradle/libs.versions.toml` (add `android-application`, `kotlin-compose` plugins, compose + activity libs)
- Create: `android/app/build.gradle.kts` (Android application, Compose; minSdk 26, compileSdk/targetSdk 34, `namespace = "app.workadventurer.app"`, depends on `:protocol`)
- Create: `android/app/src/main/kotlin/app/workadventurer/app/session/WaSession.kt`
- Test: `android/app/src/test/kotlin/app/workadventurer/app/session/WaSessionTest.kt`

**Interfaces:**
- Consumes: `PusherConnection`, `JoinFailed`, `Closed`, `RoomConfig`, `RoomState`, `Player`, `Area` (Tasks 2-5).
- Produces:

```kotlin
sealed interface Command {
    data class Join(val config: RoomConfig) : Command
    data object Leave : Command
}

sealed interface Connection {
    data object Disconnected : Connection
    data object Connecting : Connection
    data object Connected : Connection
    data class Reconnecting(val attempt: Int, val inMs: Long) : Connection
    data class Failed(val message: String) : Connection
}

data class SessionState(
    val connection: Connection = Connection.Disconnected,
    val roomName: String = "",
    val players: List<Player> = emptyList(),   // sorted by name, case-insensitive
    val areas: List<Area> = emptyList(),
    val inAreas: List<Area> = emptyList(),
)

typealias ConnectionFactory = (RoomConfig) -> PusherConnection

class WaSession(
    private val scope: CoroutineScope,
    private val factory: ConnectionFactory,
    private val backoffMs: (attempt: Int) -> Long = { minOf(30_000L, 1_000L shl (it - 1).coerceAtMost(5)) },
) {
    val state: StateFlow<SessionState>
    fun dispatch(cmd: Command)
}
```

Behaviour: `Join` → `Connecting`; `factory(cfg).connect()` success → `Connected`, mirror the connection's `RoomState.players`/areas into `SessionState`; `JoinFailed` on the **first** attempt → `Failed(message)` (no retry: bad room/version isn't transient); once connected, `conn.closed` completing → `Reconnecting(attempt, backoff)`, wait, reconnect with a **fresh** `PusherConnection` (fresh login and token); any later failure → keep retrying with backoff; `Leave` cancels everything → `Disconnected` and closes the connection. A second `Join` while active replaces the first (leave then join).

- [ ] **Step 1: Gradle module**

`android/app/build.gradle.kts` (add to `libs.versions.toml`: `agp = "8.7.3"`, plugin `android-application = { id = "com.android.application", version.ref = "agp" }`, `kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }`, and libraries `compose-bom = "androidx.compose:compose-bom:2024.10.01"`, `compose-ui`, `compose-material3`, `compose-ui-tooling-preview`, `androidx-activity-compose = "androidx.activity:activity-compose:1.9.3"`, `androidx-lifecycle-runtime-compose = "androidx.lifecycle:lifecycle-runtime-compose:2.8.7"`, `androidx-core-ktx = "androidx.core:core-ktx:1.13.1"`):

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)   // add to the catalog: id org.jetbrains.kotlin.android, version.ref kotlin
    alias(libs.plugins.kotlin.compose)
}
android {
    namespace = "app.workadventurer.app"
    compileSdk = 34
    defaultConfig {
        applicationId = "app.workadventurer"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }
    buildFeatures { compose = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation(project(":protocol"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.core.ktx)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.coroutines.test)
}
```

Create `android/local.properties` (gitignored) with `sdk.dir=/Users/campey/Library/Android/sdk`.

- [ ] **Step 2: Write the failing tests**

`WaSessionTest` uses `runTest` with `StandardTestDispatcher` and a **fake `ConnectionFactory`**. Because `PusherConnection` is a concrete class doing real I/O, extract a minimal seam first: in `PusherConnection.kt` change `class PusherConnection(` to `open class PusherConnection(` and make `connect`, `close`, and the `closed`/`log` vals `open` so tests can subclass:

```kotlin
class FakeConn(cfg: RoomConfig, val behaviour: suspend FakeConn.() -> Unit) :
    PusherConnection(OkHttpClient(), cfg) {
    val fakeClosed = CompletableDeferred<Closed>()
    override val closed get() = fakeClosed
    var connects = 0
    override suspend fun connect() { connects++; behaviour() }
    override fun close() { fakeClosed.complete(Closed(1000, "bye")) }
}
```

`WaSessionTest.kt` (full file):

```kotlin
package app.workadventurer.app.session

import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.SubMessage
import app.workadventurer.proto.UserJoinedMessage
import app.workadventurer.protocol.Closed
import app.workadventurer.protocol.JoinFailed
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class WaSessionTest {
    private val cfg = RoomConfig(name = "t")

    private class FakeConn(cfg: RoomConfig, val behaviour: suspend FakeConn.() -> Unit) :
        PusherConnection(OkHttpClient(), cfg) {
        val fakeClosed = CompletableDeferred<Closed>()
        var closeCalls = 0
        override val closed get() = fakeClosed
        override suspend fun connect() = behaviour()
        override fun close() { closeCalls++; fakeClosed.complete(Closed(1000, "bye")) }
    }

    private fun join(id: Int, name: String) = SubMessage(
        userJoinedMessage = UserJoinedMessage(userId = id, name = name, position = PositionMessage(x = 1, y = 2)),
    )

    @Test
    fun joinReachesConnectedAndMirrorsPlayersSorted() = runTest {
        val session = WaSession(backgroundScope, { c -> FakeConn(c) {
            state.applySub(join(1, "bob")); state.applySub(join(2, "Alice"))
        } })
        session.dispatch(Command.Join(cfg))
        runCurrent()
        assertEquals(Connection.Connected, session.state.value.connection)
        assertEquals(listOf("Alice", "bob"), session.state.value.players.map { it.name })
    }

    @Test
    fun firstJoinFailureIsFailedAndNotRetried() = runTest {
        var made = 0
        val session = WaSession(backgroundScope, { c -> made++; FakeConn(c) { throw JoinFailed("token expired") } })
        session.dispatch(Command.Join(cfg))
        advanceTimeBy(120_000)
        runCurrent()
        assertEquals(Connection.Failed("token expired"), session.state.value.connection)
        assertEquals(1, made)
    }

    @Test
    fun dropAfterConnectedReconnectsWithFreshConnectionAndClearsOldPlayers() = runTest {
        val made = mutableListOf<FakeConn>()
        val session = WaSession(backgroundScope, { c ->
            FakeConn(c) { state.applySub(join(made.size, "p${made.size}")) }.also { made += it }
        })
        session.dispatch(Command.Join(cfg))
        runCurrent()
        assertEquals(listOf("p1"), session.state.value.players.map { it.name })
        made[0].fakeClosed.complete(Closed(1001, "x"))
        runCurrent()
        val st = session.state.value.connection
        assertIs<Connection.Reconnecting>(st)
        assertEquals(1, st.attempt)
        assertTrue(session.state.value.players.isEmpty())
        advanceTimeBy(1_001)
        runCurrent()
        assertEquals(2, made.size)
        assertEquals(Connection.Connected, session.state.value.connection)
        assertEquals(listOf("p2"), session.state.value.players.map { it.name })
    }

    @Test
    fun repeatedFailuresBackOffAndCapAtThirtySeconds() = runTest {
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { throw java.io.IOException("net down") } })
        session.dispatch(Command.Join(cfg))
        val waits = mutableListOf<Long>()
        repeat(7) {
            runCurrent()
            val r = session.state.value.connection as Connection.Reconnecting
            waits += r.inMs
            advanceTimeBy(r.inMs + 1)
        }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), waits)
    }

    @Test
    fun leaveClosesConnectionAndGoesDisconnected() = runTest {
        var conn: FakeConn? = null
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { conn = it } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.Leave); runCurrent()
        assertEquals(Connection.Disconnected, session.state.value.connection)
        assertEquals(1, conn!!.closeCalls)
    }

    @Test
    fun secondJoinReplacesFirst() = runTest {
        val made = mutableListOf<FakeConn>()
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { made += it } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.Join(cfg.copy(name = "second"))); runCurrent()
        assertEquals(2, made.size)
        assertEquals(1, made[0].closeCalls)
        assertEquals(Connection.Connected, session.state.value.connection)
    }
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*WaSessionTest*'`
Expected: FAIL (unresolved `WaSession`).

- [ ] **Step 4: Implement `WaSession.kt`**

```kotlin
package app.workadventurer.app.session

import app.workadventurer.protocol.Area
import app.workadventurer.protocol.JoinFailed
import app.workadventurer.protocol.Player
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

// (Command, Connection, SessionState, ConnectionFactory exactly as in the Interfaces block above.)

class WaSession(
    private val scope: CoroutineScope,
    private val factory: ConnectionFactory,
    private val backoffMs: (Int) -> Long = { minOf(30_000L, 1_000L shl (it - 1).coerceAtMost(5)) },
) {
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state.asStateFlow()
    private var job: Job? = null
    private var conn: PusherConnection? = null

    fun dispatch(cmd: Command) {
        when (cmd) {
            is Command.Join -> { stop(); job = scope.launch { run(cmd.config) } }
            Command.Leave -> { stop(); _state.value = SessionState() }
        }
    }

    private fun stop() {
        job?.cancel(); job = null
        conn?.close(); conn = null
    }

    private suspend fun run(cfg: RoomConfig) {
        var attempt = 0
        var everConnected = false
        _state.value = SessionState(connection = Connection.Connecting, roomName = cfg.roomUrl)
        while (scope.isActive) {
            val c = factory(cfg)
            conn = c
            try {
                c.connect()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!everConnected && e is JoinFailed) {
                    _state.update { it.copy(connection = Connection.Failed(e.message ?: "join failed")) }
                    return
                }
                // transient: fall through to backoff
                c.close()
                attempt++
                val wait = backoffMs(attempt)
                _state.update { it.copy(connection = Connection.Reconnecting(attempt, wait)) }
                delay(wait)
                continue
            }
            everConnected = true
            attempt = 0
            val mirror = scope.launch { mirrorState(c) }
            _state.update { it.copy(connection = Connection.Connected, areas = c.state.areas) }
            c.closed.await()
            mirror.cancel()
            c.close()
            c.state.clear()
            attempt++
            val wait = backoffMs(attempt)
            _state.update { it.copy(connection = Connection.Reconnecting(attempt, wait), players = emptyList(), inAreas = emptyList()) }
            delay(wait)
        }
    }

    private suspend fun mirrorState(c: PusherConnection) {
        c.state.players.collect { map ->
            _state.update {
                it.copy(
                    players = map.values.sortedBy { p -> p.name.lowercase() },
                    inAreas = c.state.currentAreas(),
                )
            }
        }
    }
}
```

Replace the comment line with the real `Command` / `Connection` / `SessionState` / `ConnectionFactory` declarations from the Interfaces block.

- [ ] **Step 5: Run to verify they pass**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*WaSessionTest*'`
Expected: PASS (6 tests). Also re-run `./gradlew :protocol:test` to confirm the `open` changes broke nothing.

- [ ] **Step 6: Commit**

```bash
git add android
git commit -m "feat(android): WaSession with Command dispatch and reconnect

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `PresenceService` (foreground service) + manifest

**Files:**
- Create: `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/kotlin/app/workadventurer/app/PresenceService.kt`, `android/app/src/main/kotlin/app/workadventurer/app/WaApp.kt`

**Interfaces:**
- Consumes: `WaSession`, `Command`, `SessionState`, `Connection` (Task 7); `PusherConnection`, `RoomConfig` (Tasks 2/5).
- Produces:
  - `class WaApp : Application { val session: WaSession }`: one process-wide `WaSession` built with `factory = { cfg -> PusherConnection(OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build(), cfg) }` and a `CoroutineScope(SupervisorJob() + Dispatchers.Default)`. (`pingInterval` is OkHttp's TCP-level WS ping; G1 measures whether it's needed.)
  - `class PresenceService : Service`: `ACTION_JOIN` (extras `name`, `room`) dispatches `Command.Join`, `startForeground(NOTIF_ID, notification, FOREGROUND_SERVICE_TYPE_MICROPHONE)`; `ACTION_LEAVE` dispatches `Command.Leave` and `stopSelf()`. The ongoing notification text tracks `session.state` (`Connected · N players in <room>`, `Reconnecting…`, `Failed: …`) and has a **Leave** action button (a second `dispatch` caller, per the spec's seam).

- [ ] **Step 1: Manifest**

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <application
        android:name=".WaApp"
        android:label="WorkAdventure"
        android:usesCleartextTraffic="false">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <service
            android:name=".PresenceService"
            android:exported="false"
            android:foregroundServiceType="microphone" />
    </application>
</manifest>
```

- [ ] **Step 2: Implement `WaApp` and `PresenceService`**

Write both classes to the Interfaces block above. Constraints that matter on API 34: create a `NotificationChannel` before `startForeground`; `startForeground(id, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)`; a `microphone`-type FGS **throws `SecurityException` unless `RECORD_AUDIO` is already granted**, so `MainActivity` (Task 9) must obtain it before starting the service. Observe `session.state` from a service-scoped coroutine and `NotificationManager.notify(NOTIF_ID, …)` on each change. `onDestroy` dispatches `Command.Leave`. Return `START_NOT_STICKY` (don't resurrect a half-configured service with no extras; G1 findings decide if sticky is wanted).

- [ ] **Step 3: Build**

Run: `cd android && ./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL. (No unit test: this class is platform glue; its proof is the Task 10 live check.)

- [ ] **Step 4: Commit**

```bash
git add android/app
git commit -m "feat(android): PresenceService foreground service owning the session

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Compose UI (join form, players, areas)

**Files:**
- Create: `android/app/src/main/kotlin/app/workadventurer/app/MainActivity.kt`, `android/app/src/main/kotlin/app/workadventurer/app/ui/PresenceScreen.kt`
- Test: `android/app/src/test/kotlin/app/workadventurer/app/ui/PresenceFormatTest.kt`

**Interfaces:**
- Consumes: `SessionState`, `Connection`, `Player`, `Area` (Task 7); `PresenceService.ACTION_JOIN/ACTION_LEAVE` (Task 8).
- Produces: `fun statusText(c: Connection): String` and `fun playerLabel(p: Player): String` (pure, tested); `@Composable PresenceScreen(state: SessionState, onJoin: (name: String, room: String) -> Unit, onLeave: () -> Unit)`.

UI is deliberately minimal and **TalkBack-first** (this is the seed of the accessibility goal): a name field (default empty; hint says to name it after yourself), a room URL field (default `Wa133.DEFAULT_ROOM`), one Join/Leave button, a status line announced as a live region, then two lists, "Players" and "Areas" (areas marked "you are here" when in `inAreas`). Every row is a single focusable element with a full `contentDescription`/merged semantics (e.g. "Ada, at the Fire pit"); no information conveyed by colour alone; touch targets ≥ 48dp.

- [ ] **Step 1: Write the failing tests for the pure formatters**

```kotlin
package app.workadventurer.app.ui

import app.workadventurer.app.session.Connection
import app.workadventurer.proto.PositionMessage
import app.workadventurer.protocol.Player
import kotlin.test.Test
import kotlin.test.assertEquals

class PresenceFormatTest {
    @Test fun statusTextCoversEveryState() {
        assertEquals("Not in a room", statusText(Connection.Disconnected))
        assertEquals("Connecting…", statusText(Connection.Connecting))
        assertEquals("Connected", statusText(Connection.Connected))
        assertEquals("Reconnecting (attempt 2) in 4s", statusText(Connection.Reconnecting(2, 4_000)))
        assertEquals("Couldn't join: token expired", statusText(Connection.Failed("token expired")))
    }

    @Test fun playerLabelHandlesEmptyName() {
        val p = Player(1, "", "u", 0, 0, PositionMessage.Direction.DOWN)
        assertEquals("Unnamed player", playerLabel(p))
        assertEquals("Ada", playerLabel(p.copy(name = "Ada")))
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*PresenceFormatTest*'`
Expected: FAIL (unresolved).

- [ ] **Step 3: Implement the formatters and the screen**

```kotlin
package app.workadventurer.app.ui

import app.workadventurer.app.session.Connection
import app.workadventurer.protocol.Player

fun statusText(c: Connection): String = when (c) {
    Connection.Disconnected -> "Not in a room"
    Connection.Connecting -> "Connecting…"
    Connection.Connected -> "Connected"
    is Connection.Reconnecting -> "Reconnecting (attempt ${c.attempt}) in ${c.inMs / 1000}s"
    is Connection.Failed -> "Couldn't join: ${c.message}"
}

fun playerLabel(p: Player): String = p.name.ifBlank { "Unnamed player" }
```

`PresenceScreen.kt` implements the layout described above with Material3 (`OutlinedTextField`, `Button`, `LazyColumn`; status `Text` with `Modifier.semantics { liveRegion = LiveRegionMode.Polite }`).

`MainActivity`: collects `(application as WaApp).session.state` via `collectAsStateWithLifecycle`; `onJoin` first requests `RECORD_AUDIO` and `POST_NOTIFICATIONS` (via `ActivityResultContracts.RequestMultiplePermissions`), and only after `RECORD_AUDIO` is granted starts `PresenceService` with `ACTION_JOIN`, using `startForegroundService`. If denied, show the status line "Microphone permission is needed to stay connected in the background", and don't start the service. `onLeave` sends `ACTION_LEAVE`.

- [ ] **Step 4: Run to verify tests pass and the app builds**

Run: `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`
Expected: PASS, BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add android/app
git commit -m "feat(android): Compose presence screen, TalkBack-first rows

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: G1 live check: does presence survive a locked phone?

**Files:**
- Modify: `android/docs/field-notes.md` (G1 findings)

**Interfaces:** consumes the built debug APK; produces the findings write-up and a go/no-go on the architecture for G2.

- [ ] **Step 1: Run on the emulator first (smoke)**

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
$ANDROID_HOME/emulator/emulator -avd Medium_Phone -no-snapshot &     # then wait for boot
$ANDROID_HOME/platform-tools/adb wait-for-device
cd android && ./gradlew :app:installDebug
$ANDROID_HOME/platform-tools/adb shell am start -n app.workadventurer/.MainActivity
```

Grant the microphone/notification prompts, enter a worktree-derived name (e.g. `android-g1`), tap Join. Expected: notification appears; the players list matches who the browser avatar sees. Watch `adb logcat -s WaApp PresenceService` for exceptions (especially `SecurityException` on `startForeground`; if it fires, record it and switch the service type to `dataSync` as the documented fallback, noting the Android 15 six-hour limit in the findings).

- [ ] **Step 2: Doze simulation on the emulator**

```bash
$ANDROID_HOME/platform-tools/adb shell dumpsys battery unplug
$ANDROID_HOME/platform-tools/adb shell dumpsys deviceidle force-idle
```

Move the browser avatar for ~2 minutes; then `dumpsys deviceidle unforce` and `dumpsys battery reset`. Expected: record whether the socket survived (status stays `Connected`, or `Reconnecting` → `Connected`) and whether players are current on wake.

- [ ] **Step 3: The real check on the user's phone**

Ask the user to sideload (`adb install -r app/build/outputs/apk/debug/app-debug.apk`; USB or wireless debugging), join with the screen locked **about 10 minutes** while a browser avatar walks around and another joins/leaves (the spec's G1 check), then unlock. Pass criteria: the list is current, the avatar was never seen leaving (`userLeft` for `android-g1` in the browser), and any `Reconnecting` blips are logged with durations. Record: device model/Android version, battery-optimisation settings used, whether `pingInterval` mattered, whether a wake lock turned out to be necessary.

- [ ] **Step 4: Write G1 findings and decide next step**

Append to `android/docs/field-notes.md` under `## G1`: result vs. the question "does presence survive on a phone?", every surprise (FGS type, Doze/App Standby behaviour, reconnect timings, OkHttp ping), and a one-paragraph verdict on whether the architecture hypothesis holds going into G2. If it doesn't, update `docs/superpowers/specs/2026-10-05-android-client-design.md` first.

- [ ] **Step 5: Clean up and commit**

Stop the emulator and any test avatar/daemon (`wa leave` for Node daemons; kill the emulator process). Then:

```bash
git add android docs
git commit -m "docs(android): G1 live-check findings

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Post a short G0/G1 results comment on issue #54, then stop. G2 gets its own plan, informed by these findings.

---

## Self-Review

- **Spec coverage:** G0 (Tasks 0-6: Wire codegen, envelope, login/ws url, areas/spawn, reducer, connection, CLI live check) and G1 (Tasks 7-10: `WaSession` + `Command`, foreground service of type `microphone`, Compose list of players and areas, 10-minute locked-screen check). Spec items intentionally *not* here: `:nav`/follow (G2), `:voice` (G3/G4), MediaSession and TalkBack polish beyond row semantics (G5; the seam is exercised by the notification's Leave action and the `Command` type). `Command` carries only `Join`/`Leave` now; the rest of the spec's sealed class is added at the gate that needs each member (YAGNI).
- **Placeholder scan:** Task 8/9 describe platform glue (`PresenceService`, `PresenceScreen`, `MainActivity`) by contract rather than full source. These are the places an implementer must write substantial code from a precise description; the contracts (signatures, API-34 constraints, strings) are given. Everything in `:protocol` and the pure formatters has full code.
- **Type consistency:** `RoomConfig`, `Login`, `Spawn`, `Area`, `Player`, `RoomState`, `Closed`, `JoinFailed`, `PusherConnection` signatures match across Tasks 2-9; Task 7 makes `PusherConnection` `open` for the test seam and says to re-run `:protocol:test`.
- **Known risks to watch (each is a learning, not a blocker):** OkHttp's handling of a manually set `Sec-WebSocket-Protocol`; Wire's handling of this proto (`google.protobuf.Value`, wrappers); `microphone` FGS requiring `RECORD_AUDIO` before start; Doze vs. a socket-only foreground service.
