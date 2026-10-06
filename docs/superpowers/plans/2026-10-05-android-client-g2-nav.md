# Android client G2 (movement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone avatar can walk to a player, walk to a map area, and follow a player around the map, using real pathfinding around walls, driven from the app's player/area lists.

**Architecture:** A new pure-JVM `:nav` module holds the grid (`NavGrid`), A\* + smoothing, steering maths, a `CollisionBuilder` (the room's `.tmj` + `.wam` → grid, built **on the phone at runtime**), and a coroutine `Navigator` that drives a `MovementSink`. `:protocol` implements the sink (`PusherConnection.move`), loads the grid **in the background after joining** (a 1.5 MB map download must not delay the join; until it arrives movement is straight-line), and tracks the avatar's pose. `WaSession` gains movement `Command`s and an `activity` state; the Compose lists gain Follow / Walk-to / Stop actions.

**Tech Stack:** Kotlin 2.0.21, kotlinx-coroutines 1.9.0 (+ test), kotlinx-serialization-json 1.7.3, OkHttp 4.12.0 + MockWebServer, Compose (existing). Same JDK 17 / Gradle wrapper as G0/G1.

**Spec:** `docs/superpowers/specs/2026-10-05-android-client-design.md` (gate G2 and its "G2 decisions" addendum). Prior plan: `docs/superpowers/plans/2026-10-05-android-client-g0-g1.md`. Issue: #54.

## Global Constraints

- Prototype lives in `android/`. **Nothing under `android/` main or test code references the repo outside `android/`, except Gradle reading `../proto/`.** Test fixtures copied from `map/` are copied *into* `android/` by a generator script that lives **outside** `android/` (`scripts/gen-android-nav-fixtures.mjs`); runtime code never reads `../map/`.
- Collision maps are **built on the phone at runtime** from the room's `.wam` + `.tmj` (user decision for G2); the three baked `map/**/collision.json` files are test fixtures and a live parity target only.
- Target prod `play.workadventu.re` via the wa-1.33 proto; default `apiVersionHash` stays `23c8eb8c` (prod v1.34.0).
- Wire/movement behaviour is proven by **live checks**, not unit tests; unit tests cover pure logic only.
- CLAUDE.md hygiene for any live avatar: name it after the worktree/branch (`android-g2-nav`…), never bare `claude`; any Node daemon used as a stand-in uses its own port, never `8787`; clean up when done.
- Run Gradle with `JAVA_HOME=/Users/campey/.jdks/jdk-17.0.20.1+1/Contents/Home` from `android/` (see memory `android-client-build-env`); `./gradlew --no-daemon`.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. PRs merge with a plain merge commit, never squash.
- Position messages carry **int32** x/y: the pose is kept as `Double` internally and rounded only when sent.

## Out of scope for G2

- Enclosed-room logic (`roomAt` / `pointOutsideRoom` / `nearestEmptyArea` in `map-nav.mjs`): a hard-coded `board\s*room` heuristic for one map. Follow stands `spacing` px short on the approach side, nothing more.
- Joining a bubble / meeting-area Space on entering an area (G3). `inAreas` is shown, nothing is joined.
- A joystick / free movement, map rendering (later, optional).
- External (`source`-referenced) tilesets and infinite/chunked `.tmj` maps: ignored, the grid degrades (documented in Task 3, not silently).

## Review Focus

The input classes the spec implies but the tests below don't all exercise on their own, most likely first:

1. **Goal unreachable / no path** (sealed pocket, or grid not loaded yet): movement must degrade to straight-line toward the goal and **terminate** (timeout), never spin. Node had a live CPU/RSS spin-crash here. (Task 4)
2. **Followed player leaves the room mid-follow** (or a walk-to target disappears): movement stops, activity returns to Idle, no crash, one final `moving=false`. (Tasks 4, 8)
3. **Real-world `.tmj` quirks:** external tilesets, group layers, object layers, a missing `collisions` layer, Tiled flip flags in the high bits of a gid, `data` longer than `width*height`: the builder must never throw on these; at worst the grid is more open than the room. A failed/garbled `.tmj` download means `grid == null` and straight-line movement. (Tasks 3, 6)
4. **Avatar starts inside a blocked tile** (spawn in a wall, or moved there by a stale pose): `findPath` snaps the start to the nearest free tile; the spawn is nudged out once the grid loads. (Tasks 1, 5)
5. **Leave / re-Join / socket drop during movement:** the movement coroutine is cancelled, nothing keeps sending positions for the old connection, activity resets. (Task 8)

## File Structure

```
scripts/gen-android-nav-fixtures.mjs        (new, repo root: Node-side fixture generator)
android/settings.gradle.kts                 (+ :nav)
android/nav/build.gradle.kts                (new)
android/nav/src/main/kotlin/app/workadventurer/nav/
    NavGrid.kt          grid, tile math, nearestFree, fromBakedJson / blockedIndices
    Pathfinding.kt      A* + line-of-sight smoothing (extension on NavGrid)
    Steering.kt         Facing, Pt, Target, faceToward, followPoint, frontOf
    CollisionBuilder.kt .tmj + .wam -> NavGrid
    Navigator.kt        MovementSink, Outcome, Navigator (walkTo / navTo / follow)
android/nav/src/test/kotlin/...             (tests per file)
android/nav/src/test/resources/             afrolabs-collision.json, afrolabs-paths.json (generated)
android/protocol/.../RoomState.kt           (+ Pose flow)
android/protocol/.../Areas.kt               (+ fetchWamJson)
android/protocol/.../NavGridLoader.kt       (new: tmj fetch + disk cache + CollisionBuilder)
android/protocol/.../PusherConnection.kt    (+ MovementSink, grid flow, spawn nudge, facing in keepalive)
android/app/.../session/WaSession.kt        (+ movement commands, Activity)
android/app/.../ui/PresenceFormat.kt        (+ activityText)
android/app/.../ui/PresenceScreen.kt        (+ row actions, Stop)
android/app/.../MainActivity.kt, WaApp.kt   (+ routing, cacheDir, logcat)
android/wa-cli/.../Main.kt                  (+ --follow / --walk-to-area / collision parity)
```

---

### Task 0: `:nav` module + `NavGrid` core

**Files:**
- Modify: `android/settings.gradle.kts` (add `include(":nav")`), `android/protocol/build.gradle.kts` (add `api(project(":nav"))`), `android/app/build.gradle.kts` (add `implementation(project(":nav"))`)
- Create: `android/nav/build.gradle.kts`, `android/nav/src/main/kotlin/app/workadventurer/nav/NavGrid.kt`
- Test: `android/nav/src/test/kotlin/app/workadventurer/nav/NavGridTest.kt`

**Interfaces:**
- Produces:
  - `enum class Facing { UP, RIGHT, DOWN, LEFT }`, `data class Pt(val x: Double, val y: Double)` (in `Steering.kt` from Task 2; defined here first, in `NavGrid.kt`, and moved by Task 2: keep them in `NavGrid.kt`, Task 2 imports them, do **not** redefine).
  - `class NavGrid(val w: Int, val h: Int, val tile: Int, blocked: BooleanArray)` with `inBounds(tx,ty)`, `isTileBlocked(tx,ty)` (out of bounds = blocked), `pxToTile(px,py): Pair<Int,Int>`, `tileCenterPx(tx,ty): Pt`, `isPxBlocked(px,py)`, `nearestFree(tx,ty,maxR=40): Pair<Int,Int>?`, `blockedIndices(): IntArray`, `companion fun fromBlockedIndices(w,h,tile,indices: IntArray)`, `companion fun fromBakedJson(json: String)` (the `map/**/collision.json` shape: `{width,height,tile,blocked:[idx…]}`).

- [ ] **Step 1: Gradle wiring**

`android/nav/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin { jvmToolchain(17) }

dependencies {
    api(libs.coroutines.core)
    implementation(libs.serialization.json)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.coroutines.test)
}
```

`settings.gradle.kts`: add `include(":nav")` after `include(":protocol")`. In `protocol/build.gradle.kts` add `api(project(":nav"))` inside `dependencies`; in `app/build.gradle.kts` add `implementation(project(":nav"))`.

- [ ] **Step 2: Write the failing tests**

```kotlin
package app.workadventurer.nav

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** '#' = blocked, anything else free. */
fun gridOf(vararg rows: String, tile: Int = 32): NavGrid {
    val h = rows.size
    val w = rows[0].length
    require(rows.all { it.length == w })
    return NavGrid(w, h, tile, BooleanArray(w * h) { rows[it / w][it % w] == '#' })
}

class NavGridTest {
    @Test
    fun tileMathUsesFloorAndCentres() {
        val g = gridOf("....", "....", "....")
        assertEquals(1 to 2, g.pxToTile(40.0, 70.0))
        assertEquals(Pt(16.0, 16.0), g.tileCenterPx(0, 0))
        assertEquals(Pt(48.0, 80.0), g.tileCenterPx(1, 2))
        assertEquals(-1 to -1, g.pxToTile(-0.5, -31.9)) // floor, not truncation toward zero
    }

    @Test
    fun outOfBoundsCountsAsBlocked() {
        val g = gridOf("..", "..")
        assertTrue(g.isTileBlocked(-1, 0)); assertTrue(g.isTileBlocked(0, 2)); assertTrue(g.isTileBlocked(2, 0))
        assertFalse(g.isTileBlocked(1, 1))
        assertTrue(g.isPxBlocked(-5.0, 10.0))
    }

    @Test
    fun nearestFreeReturnsSelfWhenFreeAndSpiralsOutWhenBlocked() {
        val g = gridOf(".....", ".###.", ".#.#.", ".###.", ".....")
        assertEquals(2 to 2, g.nearestFree(2, 2)) // already free: returned as is
        // (1,1) is blocked; ring 1 in raster order starts at (0,0), which is free
        assertEquals(0 to 0, g.nearestFree(1, 1))
    }

    @Test
    fun nearestFreeGivesUpWhenNothingIsFreeWithinRange() {
        val g = NavGrid(3, 3, 32, BooleanArray(9) { true })
        assertNull(g.nearestFree(1, 1))
    }

    @Test
    fun bakedJsonRoundTrips() {
        val json = """{"source":{"room":"x"},"width":3,"height":2,"tile":32,"blocked":[1,4],"start":[],"areas":[]}"""
        val g = NavGrid.fromBakedJson(json)
        assertEquals(3, g.w); assertEquals(2, g.h); assertEquals(32, g.tile)
        assertTrue(g.isTileBlocked(1, 0)); assertTrue(g.isTileBlocked(1, 1)); assertFalse(g.isTileBlocked(0, 0))
        assertEquals(listOf(1, 4), g.blockedIndices().toList())
    }

    @Test
    fun badGridShapeIsRejected() {
        val e = runCatching { NavGrid(2, 2, 32, BooleanArray(3)) }.exceptionOrNull()
        assertTrue(e is IllegalArgumentException)
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd android && ./gradlew :nav:test`
Expected: FAIL (unresolved `NavGrid`, `Pt`).

- [ ] **Step 4: Implement `NavGrid.kt`**

```kotlin
package app.workadventurer.nav

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.abs
import kotlin.math.floor

enum class Facing { UP, RIGHT, DOWN, LEFT }

/** A point in map pixels. */
data class Pt(val x: Double, val y: Double)

/** A tile grid of walkable/blocked cells. Mirrors the `MapNav` class in src/map-nav.mjs. */
class NavGrid(val w: Int, val h: Int, val tile: Int, private val blocked: BooleanArray) {
    init {
        require(w > 0 && h > 0 && tile > 0 && blocked.size == w * h) {
            "bad grid ${w}x$h tile=$tile cells=${blocked.size}"
        }
    }

    fun inBounds(tx: Int, ty: Int) = tx in 0 until w && ty in 0 until h

    /** Out of bounds counts as blocked. */
    fun isTileBlocked(tx: Int, ty: Int) = !inBounds(tx, ty) || blocked[ty * w + tx]

    fun pxToTile(px: Double, py: Double): Pair<Int, Int> = floor(px / tile).toInt() to floor(py / tile).toInt()

    fun tileCenterPx(tx: Int, ty: Int) = Pt(tx * tile + tile / 2.0, ty * tile + tile / 2.0)

    fun isPxBlocked(px: Double, py: Double): Boolean {
        val (tx, ty) = pxToTile(px, py)
        return isTileBlocked(tx, ty)
    }

    /** Nearest free tile to (tx,ty), spiralling outward ring by ring in raster order; null if none within [maxR]. */
    fun nearestFree(tx: Int, ty: Int, maxR: Int = 40): Pair<Int, Int>? {
        if (!isTileBlocked(tx, ty)) return tx to ty
        for (r in 1..maxR) {
            for (dy in -r..r) {
                for (dx in -r..r) {
                    if (maxOf(abs(dx), abs(dy)) != r) continue
                    if (!isTileBlocked(tx + dx, ty + dy)) return (tx + dx) to (ty + dy)
                }
            }
        }
        return null
    }

    fun blockedIndices(): IntArray = blocked.indices.filter { blocked[it] }.toIntArray()

    companion object {
        fun fromBlockedIndices(w: Int, h: Int, tile: Int, indices: IntArray): NavGrid {
            val b = BooleanArray(w * h)
            for (i in indices) if (i in b.indices) b[i] = true
            return NavGrid(w, h, tile, b)
        }

        /** The baked `collision.json` shape: `{width,height,tile,blocked:[tile indices]}` (other keys ignored). */
        fun fromBakedJson(json: String): NavGrid {
            val o = Json.parseToJsonElement(json).jsonObject
            return fromBlockedIndices(
                o.getValue("width").jsonPrimitive.int,
                o.getValue("height").jsonPrimitive.int,
                o.getValue("tile").jsonPrimitive.int,
                o.getValue("blocked").jsonArray.map { it.jsonPrimitive.int }.toIntArray(),
            )
        }
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd android && ./gradlew :nav:test`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add android
git commit -m "feat(android): :nav module with NavGrid core

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 1: A\* pathfinding with line-of-sight smoothing (Node parity)

**Files:**
- Create: `scripts/gen-android-nav-fixtures.mjs` (repo root, outside `android/`), `android/nav/src/main/kotlin/app/workadventurer/nav/Pathfinding.kt`
- Generated (committed): `android/nav/src/test/resources/afrolabs-collision.json`, `android/nav/src/test/resources/afrolabs-paths.json`
- Test: `android/nav/src/test/kotlin/app/workadventurer/nav/PathfindingTest.kt`

**Interfaces:**
- Consumes: `NavGrid`, `Pt` (Task 0), `gridOf` test helper (Task 0 test file; same package).
- Produces: `fun NavGrid.findPath(from: Pt, to: Pt): List<Pt>?`: pixel-space waypoints (tile centres, smoothed), start/goal snapped to the nearest free tile, `null` if unreachable; a start tile equal to the goal tile yields a single point. **A straight port of `MapNav.findPath` including its binary heap, direction order, octile heuristic, no-corner-cutting rule and `_lineClear` (with its `err += dy === 0 ? 0 : dx` quirk), so paths match the Node implementation exactly.**

- [ ] **Step 1: Generate the Node-side fixtures**

`scripts/gen-android-nav-fixtures.mjs`:

```js
// Generates test fixtures for android/nav from the Node implementation, so the Kotlin A* can be
// checked for exact parity with src/map-nav.mjs. Run from the repo root: node scripts/gen-android-nav-fixtures.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MapNav } from "../src/map-nav.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "map/afrolabs/afrolabs/open-space/collision.json");
const outDir = path.join(root, "android/nav/src/test/resources");
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, path.join(outDir, "afrolabs-collision.json"));

const nav = MapNav.load(src);
const W = nav.w * nav.tile;
const H = nav.h * nav.tile;
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pt = () => [Math.round(rnd() * W), Math.round(rnd() * H)];

const cases = [];
for (let i = 0; i < 40; i++) {
  const from = pt();
  const to = pt();
  cases.push({ from, to, path: nav.findPath(from[0], from[1], to[0], to[1]) });
}
// every start tile -> every named area centre
for (const s of nav.startTiles.slice(0, 2)) {
  const from = nav.tileCenterPx(s % nav.w, (s / nav.w) | 0);
  for (const a of nav.areas) {
    const to = [Math.round(a.x + a.w / 2), Math.round(a.y + a.h / 2)];
    cases.push({ from, to, path: nav.findPath(from[0], from[1], to[0], to[1]) });
  }
}
fs.writeFileSync(path.join(outDir, "afrolabs-paths.json"), JSON.stringify(cases));
console.log(`wrote ${cases.length} cases (${cases.filter((c) => !c.path).length} unreachable) to ${outDir}`);
```

Run: `node scripts/gen-android-nav-fixtures.mjs`
Expected: `wrote 74 cases (… unreachable) …` (the exact count depends on the area count; just check it wrote both files).

- [ ] **Step 2: Write the failing tests**

```kotlin
package app.workadventurer.nav

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.hypot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PathfindingTest {
    private fun at(g: NavGrid, tx: Int, ty: Int) = g.tileCenterPx(tx, ty)

    /** Every consecutive pair of waypoints must be walkable tile-to-tile. */
    private fun assertWalkable(g: NavGrid, path: List<Pt>) {
        for ((a, b) in path.zipWithNext()) {
            val n = (hypot(b.x - a.x, b.y - a.y) / 4).toInt().coerceAtLeast(1)
            for (i in 0..n) {
                val x = a.x + (b.x - a.x) * i / n
                val y = a.y + (b.y - a.y) * i / n
                assertTrue(!g.isPxBlocked(x, y), "walked into a wall at $x,$y")
            }
        }
    }

    @Test
    fun openGroundSmoothsToTwoPoints() {
        val g = gridOf("......", "......", "......")
        val p = g.findPath(at(g, 0, 0), at(g, 5, 2))!!
        assertEquals(listOf(at(g, 0, 0), at(g, 5, 2)), p)
    }

    @Test
    fun startEqualsGoalTileIsASinglePoint() {
        val g = gridOf("...", "...")
        assertEquals(listOf(at(g, 1, 1)), g.findPath(Pt(40.0, 40.0), Pt(50.0, 45.0)))
    }

    @Test
    fun routesThroughTheGapInAWall() {
        val g = gridOf(
            ".....#.....",
            ".....#.....",
            ".....#.....",
            "...........",
            ".....#.....",
            ".....#.....",
        )
        val p = g.findPath(at(g, 1, 0), at(g, 9, 5))!!
        // Column 5 is solid except row 3, so a walkable path must bend through the gap.
        assertWalkable(g, p)
        assertTrue(p.size >= 3, "expected a bend through the gap, got $p")
        assertEquals(at(g, 1, 0), p.first())
        assertEquals(at(g, 9, 5), p.last())
    }

    @Test
    fun noDiagonalCornerCutting() {
        // The only link between the two halves is a diagonal squeeze between two blocked tiles.
        val g = gridOf("..#", ".#.", "#..")
        // (0,0)-(1,0)-(0,1) is the top-left pocket; (2,1),(1,2),(2,2) the bottom-right one.
        assertNull(g.findPath(at(g, 0, 0), at(g, 2, 2)))
    }

    @Test
    fun startSealedInsideAPocketIsUnreachable() {
        val g = gridOf("#####", "#.#..", "#####")
        assertNull(g.findPath(at(g, 1, 1), at(g, 4, 1)))
    }

    @Test
    fun startInsideAWallSnapsToTheNearestFreeTile() {
        val g = gridOf(".....", ".###.", ".###.", ".....")
        val p = g.findPath(at(g, 2, 1), at(g, 4, 3))
        assertNotNull(p)
        assertTrue(!g.isPxBlocked(p.first().x, p.first().y), "path must start on a free tile")
    }

    @Test
    fun matchesTheNodeImplementationOnTheRealAfrolabsMap() {
        val res = PathfindingTest::class.java
        val grid = NavGrid.fromBakedJson(res.getResource("/afrolabs-collision.json")!!.readText())
        val cases = Json.parseToJsonElement(res.getResource("/afrolabs-paths.json")!!.readText()).jsonArray
        assertTrue(cases.size >= 40)
        var reachable = 0
        for ((i, c) in cases.withIndex()) {
            val o = c.jsonObject
            val from = o.getValue("from").jsonArray.map { it.jsonPrimitive.double }
            val to = o.getValue("to").jsonArray.map { it.jsonPrimitive.double }
            val expected = o.getValue("path")
            val actual = grid.findPath(Pt(from[0], from[1]), Pt(to[0], to[1]))
            if (expected is JsonNull) {
                assertNull(actual, "case $i: Node found no path, Kotlin did")
            } else {
                reachable++
                val exp = (expected as JsonArray).map { p -> p.jsonArray.map { it.jsonPrimitive.double } }
                assertEquals(exp.map { Pt(it[0], it[1]) }, actual, "case $i from=$from to=$to")
            }
        }
        assertTrue(reachable > 20, "fixture should contain plenty of reachable cases, had $reachable")
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd android && ./gradlew :nav:test --tests '*PathfindingTest*'`
Expected: FAIL (unresolved `findPath`).

- [ ] **Step 4: Implement `Pathfinding.kt`**

```kotlin
package app.workadventurer.nav

import kotlin.math.SQRT2
import kotlin.math.abs
import kotlin.math.min

private class Entry(val f: Double, val i: Int)

/** The same binary min-heap as src/map-nav.mjs (ties resolve identically, so paths match Node exactly). */
private class Heap {
    private val a = ArrayList<Entry>()
    val size get() = a.size

    fun push(i: Int, f: Double) {
        a.add(Entry(f, i))
        var c = a.size - 1
        while (c > 0) {
            val p = (c - 1) shr 1
            if (a[p].f <= a[c].f) break
            val t = a[p]; a[p] = a[c]; a[c] = t
            c = p
        }
    }

    fun pop(): Entry {
        val top = a[0]
        val last = a.removeAt(a.size - 1)
        if (a.isNotEmpty()) {
            a[0] = last
            var p = 0
            while (true) {
                val l = 2 * p + 1
                val r = l + 1
                var m = p
                if (l < a.size && a[l].f < a[m].f) m = l
                if (r < a.size && a[r].f < a[m].f) m = r
                if (m == p) break
                val t = a[m]; a[m] = a[p]; a[p] = t
                p = m
            }
        }
        return top
    }
}

private val DIRS = arrayOf(
    intArrayOf(1, 0), intArrayOf(-1, 0), intArrayOf(0, 1), intArrayOf(0, -1),
    intArrayOf(1, 1), intArrayOf(1, -1), intArrayOf(-1, 1), intArrayOf(-1, -1),
)
private val COSTS = doubleArrayOf(1.0, 1.0, 1.0, 1.0, SQRT2, SQRT2, SQRT2, SQRT2)

/** True if a straight line between two tile centres stays on free tiles (no diagonal corner cutting). */
private fun NavGrid.lineClear(ax: Int, ay: Int, bx: Int, by: Int): Boolean {
    var x0 = ax
    var y0 = ay
    val dx = abs(bx - ax)
    val dy = abs(by - ay)
    val sx = if (ax < bx) 1 else -1
    val sy = if (ay < by) 1 else -1
    var err = dx - dy
    while (true) {
        if (isTileBlocked(x0, y0)) return false
        if (x0 != bx && y0 != by) {
            if (isTileBlocked(x0 + sx, y0) && isTileBlocked(x0, y0 + sy)) return false
        }
        if (x0 == bx && y0 == by) return true
        val e2 = 2 * err
        if (e2 > -dy) { err -= dy; x0 += sx }
        // `dy == 0` quirk kept on purpose: it is what src/map-nav.mjs does, and we test for exact parity.
        if (e2 < dx) { err += if (dy == 0) 0 else dx; y0 += sy }
    }
}

/**
 * Pixel-space path as smoothed waypoints (tile centres), or null if unreachable. Start and goal are snapped
 * to the nearest free tile. A\* on an 8-connected grid, then line-of-sight smoothing. Port of `MapNav.findPath`.
 */
fun NavGrid.findPath(from: Pt, to: Pt): List<Pt>? {
    val (sx0, sy0) = pxToTile(from.x, from.y)
    val (gx0, gy0) = pxToTile(to.x, to.y)
    val s = nearestFree(sx0, sy0) ?: return null
    val g = nearestFree(gx0, gy0) ?: return null
    val sx = s.first; val sy = s.second
    val gx = g.first; val gy = g.second
    if (sx == gx && sy == gy) return listOf(tileCenterPx(gx, gy))

    val n = w * h
    val came = IntArray(n) { -1 }
    val gScore = DoubleArray(n) { Double.POSITIVE_INFINITY }
    val start = sy * w + sx
    val goal = gy * w + gx
    gScore[start] = 0.0

    fun heuristic(i: Int): Double { // octile
        val dx = abs(i % w - gx)
        val dy = abs(i / w - gy)
        return (dx + dy) + (SQRT2 - 2) * min(dx, dy)
    }

    val heap = Heap()
    heap.push(start, heuristic(start))
    while (heap.size > 0) {
        val cur = heap.pop().i
        if (cur == goal) break
        val cx = cur % w
        val cy = cur / w
        for (d in DIRS.indices) {
            val dx = DIRS[d][0]
            val dy = DIRS[d][1]
            val nx = cx + dx
            val ny = cy + dy
            if (isTileBlocked(nx, ny)) continue
            if (dx != 0 && dy != 0) {
                if (isTileBlocked(cx + dx, cy) || isTileBlocked(cx, cy + dy)) continue // no corner cutting
            }
            val ni = ny * w + nx
            val ng = gScore[cur] + COSTS[d]
            if (ng < gScore[ni]) {
                gScore[ni] = ng
                came[ni] = cur
                heap.push(ni, ng + heuristic(ni))
            }
        }
    }
    if (came[goal] == -1 && goal != start) return null

    val tiles = ArrayList<IntArray>()
    var i = goal
    while (i != -1) {
        tiles.add(intArrayOf(i % w, i / w))
        if (i == start) break
        i = came[i]
    }
    tiles.reverse()

    val smooth = arrayListOf(tiles[0])
    var anchor = 0
    for (k in 2 until tiles.size) {
        val a = tiles[anchor]
        val c = tiles[k]
        if (!lineClear(a[0], a[1], c[0], c[1])) {
            smooth.add(tiles[k - 1])
            anchor = k - 1
        }
    }
    smooth.add(tiles.last())
    return smooth.map { tileCenterPx(it[0], it[1]) }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd android && ./gradlew :nav:test`
Expected: PASS. If `matchesTheNodeImplementationOnTheRealAfrolabsMap` fails on an exact-equality mismatch, **do not loosen it first**: compare the first differing case against Node to find the porting slip (heap tie-breaks and `DIRS` order are the usual suspects). Only if the two are provably both optimal and differ solely by tie-breaking, relax that one assertion to "same total length and walkable" and record a ledger ruling.

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-android-nav-fixtures.mjs android
git commit -m "feat(android): A* pathfinding, exact parity with map-nav.mjs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Steering maths (`faceToward`, `followPoint`, `frontOf`)

**Files:**
- Create: `android/nav/src/main/kotlin/app/workadventurer/nav/Steering.kt`
- Test: `android/nav/src/test/kotlin/app/workadventurer/nav/SteeringTest.kt`

**Interfaces:**
- Consumes: `NavGrid`, `Pt`, `Facing` (Task 0), `gridOf` (Task 0 tests).
- Produces:
  - `data class Target(val x: Double, val y: Double, val facing: Facing)`
  - `fun faceToward(fromX: Double, fromY: Double, toX: Double, toY: Double): Facing`
  - `fun followPoint(me: Pt, target: Pt, spacing: Double = 72.0, grid: NavGrid? = null): Pt`: `spacing` px short of the target, on the side we're approaching from; snapped to a free tile if blocked. (No enclosed-room logic, see "Out of scope".)
  - `fun frontOf(target: Target, me: Pt, spacing: Double = 64.0, grid: NavGrid? = null): Pt`: `spacing` px in front of them (their eyeline); falls back to `followPoint` if that spot is blocked with no free tile near.

- [ ] **Step 1: Write the failing tests**

```kotlin
package app.workadventurer.nav

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SteeringTest {
    @Test
    fun faceTowardPicksTheDominantAxis() {
        assertEquals(Facing.RIGHT, faceToward(0.0, 0.0, 10.0, 3.0))
        assertEquals(Facing.LEFT, faceToward(0.0, 0.0, -10.0, 3.0))
        assertEquals(Facing.DOWN, faceToward(0.0, 0.0, 3.0, 10.0))
        assertEquals(Facing.UP, faceToward(0.0, 0.0, 3.0, -10.0))
        assertEquals(Facing.UP, faceToward(0.0, 0.0, 0.0, 0.0)) // no direction falls through to UP, as in the Node client
    }

    @Test
    fun followPointStandsShortOnTheApproachSide() {
        val p = followPoint(me = Pt(0.0, 0.0), target = Pt(100.0, 0.0), spacing = 72.0)
        assertEquals(28.0, p.x, 1e-9) // 72 px short of the target, on our side
        assertEquals(0.0, p.y, 1e-9)
    }

    @Test
    fun followPointOnTopOfTheTargetStepsBelowIt() {
        val p = followPoint(me = Pt(100.0, 100.0), target = Pt(100.0, 100.0), spacing = 72.0)
        assertEquals(Pt(100.0, 172.0), p)
    }

    @Test
    fun followPointSnapsOffABlockedTile() {
        val g = gridOf("...", ".#.", "...")
        // target right of the wall; the approach point lands on the blocked tile (1,1)
        val p = followPoint(me = Pt(16.0, 48.0), target = Pt(48.0 + 40.0, 48.0), spacing = 40.0, grid = g)
        assertTrue(!g.isPxBlocked(p.x, p.y), "point $p is still blocked")
    }

    @Test
    fun frontOfStandsInTheirEyeline() {
        assertEquals(Pt(100.0, 136.0), frontOf(Target(100.0, 100.0, Facing.DOWN), me = Pt(0.0, 0.0), spacing = 36.0))
        assertEquals(Pt(64.0, 100.0), frontOf(Target(100.0, 100.0, Facing.LEFT), me = Pt(0.0, 0.0), spacing = 36.0))
        assertEquals(Pt(100.0, 64.0), frontOf(Target(100.0, 100.0, Facing.UP), me = Pt(0.0, 0.0), spacing = 36.0))
        assertEquals(Pt(136.0, 100.0), frontOf(Target(100.0, 100.0, Facing.RIGHT), me = Pt(0.0, 0.0), spacing = 36.0))
    }

    @Test
    fun frontOfSnapsToAFreeTileWhenTheSpotIsBlocked() {
        val g = gridOf(".....", ".....", ".##..", ".....")
        // target at tile (1,1) facing down; 64px in front is tile (1,3)-ish... use a spacing that lands in the wall
        val p = frontOf(Target(48.0, 48.0, Facing.DOWN), me = Pt(0.0, 0.0), spacing = 32.0, grid = g)
        assertTrue(!g.isPxBlocked(p.x, p.y), "point $p is blocked")
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :nav:test --tests '*SteeringTest*'`
Expected: FAIL (unresolved).

- [ ] **Step 3: Implement `Steering.kt`**

```kotlin
package app.workadventurer.nav

import kotlin.math.abs
import kotlin.math.hypot

/** Where another avatar is and which way it faces. */
data class Target(val x: Double, val y: Double, val facing: Facing)

fun faceToward(fromX: Double, fromY: Double, toX: Double, toY: Double): Facing {
    val dx = toX - fromX
    val dy = toY - fromY
    return if (abs(dx) > abs(dy)) {
        if (dx > 0) Facing.RIGHT else Facing.LEFT
    } else {
        if (dy > 0) Facing.DOWN else Facing.UP
    }
}

private fun NavGrid.snapped(x: Double, y: Double): Pt? {
    if (!isPxBlocked(x, y)) return Pt(x, y)
    val (tx, ty) = pxToTile(x, y)
    val free = nearestFree(tx, ty) ?: return null
    return tileCenterPx(free.first, free.second)
}

/** Where to stand `spacing` px short of [target], on the side we approach from. */
fun followPoint(me: Pt, target: Pt, spacing: Double = 72.0, grid: NavGrid? = null): Pt {
    var dx = me.x - target.x
    var dy = me.y - target.y
    var d = hypot(dx, dy)
    if (d < 1) { dx = 0.0; dy = 1.0; d = 1.0 } // on top of them: step below
    val gx = target.x + dx / d * spacing
    val gy = target.y + dy / d * spacing
    return grid?.snapped(gx, gy) ?: Pt(gx, gy)
}

/** Where to stand to face [target] from the front: `spacing` px away in the direction they face. */
fun frontOf(target: Target, me: Pt, spacing: Double = 64.0, grid: NavGrid? = null): Pt {
    val (vx, vy) = when (target.facing) {
        Facing.UP -> 0 to -1
        Facing.RIGHT -> 1 to 0
        Facing.DOWN -> 0 to 1
        Facing.LEFT -> -1 to 0
    }
    val gx = target.x + vx * spacing
    val gy = target.y + vy * spacing
    if (grid != null && grid.isPxBlocked(gx, gy)) {
        return grid.snapped(gx, gy) ?: followPoint(me, Pt(target.x, target.y), spacing, grid)
    }
    return Pt(gx, gy)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :nav:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android
git commit -m "feat(android): steering maths (faceToward, followPoint, frontOf)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `CollisionBuilder` (`.tmj` + `.wam` → `NavGrid`)

**Files:**
- Create: `android/nav/src/main/kotlin/app/workadventurer/nav/CollisionBuilder.kt`
- Test: `android/nav/src/test/kotlin/app/workadventurer/nav/CollisionBuilderTest.kt`

**Interfaces:**
- Consumes: `NavGrid` (Task 0).
- Produces: `object CollisionBuilder { fun build(wamJson: String, tmjJson: String): NavGrid? }`: returns `null` only when the `.tmj` has no usable `width`/`height`/`tilewidth` (or isn't JSON). Mirrors `scripts/build-collision.mjs` (three sources of "blocked"): (1) any non-zero cell of the layer named `collisions`; (2) any tile layer cell whose gid (low 29 bits, i.e. Tiled flip flags stripped) belongs to an **inline** tileset tile with property `collides: true` (`gid = firstgid + tile.id`); (3) `.wam` entities, blocking the tile under the entity centre `floor((x + tile/2)/tile)` and, unless the prefab id contains `stool` or `chair`, the 3×3 block around it. Group layers are flattened. Never throws on malformed *parts* (see Review Focus 3).

- [ ] **Step 1: Write the failing tests**

```kotlin
package app.workadventurer.nav

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CollisionBuilderTest {
    // 5 x 4 map, tile 32, indices 0..19 row-major.
    private fun tmj(layers: String, tilesets: String = "[]", w: Int = 5, h: Int = 4) =
        """{"width":$w,"height":$h,"tilewidth":32,"tileheight":32,"tilesets":$tilesets,"layers":$layers}"""

    private val noWam = """{"entities":{},"areas":[]}"""

    @Test
    fun collisionsLayerBlocksEveryNonZeroCell() {
        val g = CollisionBuilder.build(
            noWam,
            tmj("""[{"type":"tilelayer","name":"collisions","data":[0,0,5,0,0, 0,0,0,0,0, 7,0,0,0,0, 0,0,0,0,3]}]"""),
        )!!
        assertEquals(listOf(2, 10, 19), g.blockedIndices().toList())
        assertEquals(5, g.w); assertEquals(4, g.h); assertEquals(32, g.tile)
    }

    @Test
    fun collidesTilesetTilesBlockTheirCellsOnAnyLayerAndFlipFlagsAreStripped() {
        // firstgid 10, tile id 2 collides -> gid 12. Cell 4 holds gid 12 with the horizontal-flip bit (0x80000000) set.
        val flipped = 12L or 0x80000000L
        val g = CollisionBuilder.build(
            noWam,
            tmj(
                """[{"type":"tilelayer","name":"walls","data":[0,0,0,0,$flipped, 0,12,0,0,0, 0,0,0,0,0, 0,0,0,0,11]}]""",
                """[{"firstgid":10,"tiles":[{"id":2,"properties":[{"name":"collides","value":true}]},{"id":1,"properties":[{"name":"collides","value":false}]}]}]""",
            ),
        )!!
        assertEquals(listOf(4, 6), g.blockedIndices().toList()) // cell 19 holds gid 11 (collides=false): free
    }

    @Test
    fun stringTrueCountsAndGroupLayersAreFlattened() {
        val g = CollisionBuilder.build(
            noWam,
            tmj(
                """[{"type":"group","name":"g","layers":[{"type":"tilelayer","name":"inner","data":[3,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0]}]}]""",
                """[{"firstgid":1,"tiles":[{"id":2,"properties":[{"name":"collides","value":"true"}]}]}]""",
            ),
        )!!
        assertEquals(listOf(0), g.blockedIndices().toList())
    }

    @Test
    fun wamEntitiesBlockTheirFootprint() {
        // stool at (64,32) -> tile (2,1) only; table at (96,64) -> centre tile (3,2) plus the 3x3 around it.
        val wam = """{"entities":{
            "a":{"x":64,"y":32,"prefabRef":{"id":"LimeZu:Bar Stool:#fff:Down"}},
            "b":{"x":96,"y":64,"prefabRef":{"id":"LimeZu:Big Table"}}}}"""
        val g = CollisionBuilder.build(wam, tmj("""[{"type":"tilelayer","name":"x","data":[]}]"""))!!
        val blocked = g.blockedIndices().toSet()
        assertTrue(7 in blocked) // stool tile (2,1) = 1*5+2
        // table: tiles x 2..4, y 1..3 clipped to the 5x4 map
        for (ty in 1..3) for (tx in 2..4) assertTrue(ty * 5 + tx in blocked, "tile ($tx,$ty)")
        assertEquals(9, blocked.size) // 3x3 block includes the stool's tile; nothing else
    }

    @Test
    fun entitiesOutsideTheMapAreIgnored() {
        val wam = """{"entities":{"a":{"x":-500,"y":9000,"prefabRef":{"id":"Table"}}}}"""
        val g = CollisionBuilder.build(wam, tmj("""[]"""))!!
        assertEquals(0, g.blockedIndices().size)
    }

    @Test
    fun aDataArrayLongerThanTheMapDoesNotOverflow() {
        // 25 non-zero cells on a 20-cell map: the extra five are ignored, the 20 real ones are blocked.
        val g = CollisionBuilder.build(
            noWam,
            tmj("""[{"type":"tilelayer","name":"collisions","data":[1,1,1,1,1, 1,1,1,1,1, 1,1,1,1,1, 1,1,1,1,1, 1,1,1,1,1]}]"""),
        )!!
        assertEquals(20, g.blockedIndices().size)
    }

    @Test
    fun degradesInsteadOfThrowingOnRealWorldQuirks() {
        // an object layer (no data), an external tileset (source only, no inline tiles), an entity without x/y,
        // and wrongly-typed fields: none of it may throw; unusable parts are skipped
        val g = CollisionBuilder.build(
            """{"entities":{"a":{"prefabRef":{}},"b":{"x":"left","y":[1],"prefabRef":"nope"},"c":7}}""",
            tmj(
                """[{"type":"objectgroup","name":"floorLayer","objects":[]},
                    {"type":"tilelayer","name":"collisions","data":[1,"x",null,1,1, 1,1,1,1,1, 1,1,1,1,1, 1,1,1,1,1]}]""",
                """[{"firstgid":1,"source":"external.tsx"},{"firstgid":"bad","tiles":5}]""",
            ),
        )
        assertNotNull(g)
        // cells 1 ("x") and 2 (null) aren't numbers and are skipped; the other 18 are blocked. No crash.
        assertEquals((0 until 20).filter { it != 1 && it != 2 }, g.blockedIndices().toList())
    }

    @Test
    fun unusableTmjYieldsNull() {
        assertNull(CollisionBuilder.build(noWam, "not json"))
        assertNull(CollisionBuilder.build(noWam, """{"layers":[]}"""))
        assertNull(CollisionBuilder.build(noWam, """{"width":0,"height":3,"tilewidth":32,"layers":[]}"""))
    }

    @Test
    fun aGarbledWamStillGivesTheTmjCollisions() {
        val g = CollisionBuilder.build(
            "{{{ nope",
            tmj("""[{"type":"tilelayer","name":"collisions","data":[1,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0]}]"""),
        )!!
        assertEquals(listOf(0), g.blockedIndices().toList())
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :nav:test --tests '*CollisionBuilderTest*'`
Expected: FAIL (unresolved `CollisionBuilder`).

- [ ] **Step 3: Implement `CollisionBuilder.kt`**

```kotlin
package app.workadventurer.nav

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlin.math.floor

// Type-safe accessors: a field of the wrong JSON type reads as null instead of throwing.
private fun JsonElement?.obj() = this as? JsonObject
private fun JsonElement?.arr() = this as? JsonArray
private fun JsonElement?.prim() = this as? JsonPrimitive
private fun JsonElement?.str() = prim()?.takeIf { it.isString }?.contentOrNull
private fun JsonElement?.int() = prim()?.intOrNull
private fun JsonElement?.long() = prim()?.longOrNull
private fun JsonElement?.dbl() = prim()?.doubleOrNull

/**
 * Builds a [NavGrid] from a room's `.tmj` (Tiled map) and `.wam` (map-storage metadata) at runtime.
 * Port of scripts/build-collision.mjs. Deliberately tolerant: a malformed part is skipped, never thrown,
 * so the worst case is a grid more open than the room. Documented gaps: external tilesets (`source` only,
 * no inline tiles) and infinite/chunked maps (layers without a plain `data` array) contribute nothing.
 */
object CollisionBuilder {
    private const val GID_MASK = 0x1fffffffL // strips Tiled's flip flags in the high bits
    private val SMALL_PROP = Regex("(stool|chair)")

    /** The grid, or null if the `.tmj` isn't JSON or has no usable `width`/`height`/`tilewidth`. */
    fun build(wamJson: String, tmjJson: String): NavGrid? {
        val tmj = parse(tmjJson).obj() ?: return null
        val w = tmj["width"].int() ?: return null
        val h = tmj["height"].int() ?: return null
        val tile = tmj["tilewidth"].int() ?: return null
        if (w <= 0 || h <= 0 || tile <= 0) return null
        val cells = w * h

        val blocked = BooleanArray(cells)
        val layers = flatten(tmj["layers"].arr()).filter { it["type"].str() == "tilelayer" }

        // (1) the dedicated `collisions` layer: any non-zero cell
        layers.firstOrNull { it["name"].str() == "collisions" }?.let { layer ->
            forEachCell(layer, cells) { i, gid -> if (gid != 0L) blocked[i] = true }
        }

        // (2) tiles flagged `collides: true` in any inline tileset, on any layer
        val collidesGids = HashSet<Long>()
        for (ts in tmj["tilesets"].arr().orEmpty()) {
            val o = ts.obj() ?: continue
            val first = o["firstgid"].long() ?: continue
            for (t in o["tiles"].arr().orEmpty()) {
                val to = t.obj() ?: continue
                val id = to["id"].long() ?: continue
                val collides = to["properties"].arr().orEmpty().any { p ->
                    val po = p.obj()
                    val v = po?.get("value").prim()
                    po?.get("name").str() == "collides" && (v?.booleanOrNull == true || v?.contentOrNull == "true")
                }
                if (collides) collidesGids += first + id
            }
        }
        if (collidesGids.isNotEmpty()) {
            for (layer in layers) {
                forEachCell(layer, cells) { i, gid -> if (gid != 0L && (gid and GID_MASK) in collidesGids) blocked[i] = true }
            }
        }

        // (3) furniture entities from the .wam: the tile under the centre, plus 3x3 unless it's a stool/chair
        for ((_, e) in parse(wamJson).obj()?.get("entities").obj().orEmpty()) {
            val eo = e.obj() ?: continue
            val x = eo["x"].dbl() ?: continue
            val y = eo["y"].dbl() ?: continue
            val id = (eo["prefabRef"].obj()?.get("id").str() ?: "").lowercase()
            val r = if (SMALL_PROP.containsMatchIn(id)) 0 else 1
            val cx = floor((x + tile / 2.0) / tile).toInt()
            val cy = floor((y + tile / 2.0) / tile).toInt()
            for (dy in -r..r) for (dx in -r..r) {
                val tx = cx + dx
                val ty = cy + dy
                if (tx in 0 until w && ty in 0 until h) blocked[ty * w + tx] = true
            }
        }
        return NavGrid(w, h, tile, blocked)
    }

    private fun parse(s: String): JsonElement? = try { Json.parseToJsonElement(s) } catch (e: Exception) { null }

    private fun flatten(layers: JsonArray?): List<JsonObject> = buildList {
        for (l in layers.orEmpty()) {
            val o = l.obj() ?: continue
            if (o["type"].str() == "group") addAll(flatten(o["layers"].arr())) else add(o)
        }
    }

    /** Calls [f] with (cell index, raw gid) for each cell of a layer's plain `data` array, up to [limit] cells. */
    private inline fun forEachCell(layer: JsonObject, limit: Int, f: (Int, Long) -> Unit) {
        val data = layer["data"].arr() ?: return
        for (i in 0 until minOf(data.size, limit)) {
            val gid = data[i].long() ?: continue
            f(i, gid)
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :nav:test`
Expected: PASS (the `collisions`-layer test expects indices `[2,10,19]`; if a test fails, fix the code rather than the test, except for an arithmetic slip you can prove in the test's own comment).

- [ ] **Step 5: Commit**

```bash
git add android
git commit -m "feat(android): CollisionBuilder, runtime .tmj+.wam -> NavGrid

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 4: `Navigator` (walk, navigate, follow as coroutines)

**Files:**
- Create: `android/nav/src/main/kotlin/app/workadventurer/nav/Navigator.kt`
- Test: `android/nav/src/test/kotlin/app/workadventurer/nav/NavigatorTest.kt`

**Interfaces:**
- Consumes: `NavGrid`, `Pt`, `Facing` (Task 0), `findPath` (Task 1), `Target`, `faceToward`, `followPoint` (Task 2).
- Produces:
  - `interface MovementSink { fun position(): Pt; fun move(x: Double, y: Double, facing: Facing, moving: Boolean) }`
  - `enum class Outcome { ARRIVED, TIMEOUT, TARGET_GONE }`
  - `class Navigator(grid: () -> NavGrid?, sink: MovementSink, nowMs: () -> Long)` with
    - `suspend fun walkTo(target: Pt, stopWithin: Double = 48.0, stepPx: Double = 32.0, tickMs: Long = 120, timeoutMs: Long = 60_000, getTarget: (() -> Pt?)? = null): Outcome` (straight line);
    - `suspend fun navTo(target: Pt, stopWithin: Double = 48.0, getTarget: (() -> Pt?)? = null, face: (() -> Pt?)? = null, timeoutMs: Long = 120_000, repathMs: Long = 2_000): Outcome` (A\* route, re-planned every `repathMs`, straight-line when there is no grid or no path);
    - `suspend fun follow(getTarget: () -> Target?, spacing: Double = 72.0, tickMs: Long = 100, stepPx: Double = 30.0, arriveSlack: Double = 20.0): Outcome` (runs until the target is gone or the coroutine is cancelled).
  - Cancellation replaces the Node client's `AbortSignal`. **Every exit (arrival, timeout, target gone, cancellation) sends exactly one final `moving=false` if the avatar was moving.** Between waypoints no "stopped" message is sent (the Node client sends one per waypoint, which makes other players' avatars stutter). A minimum 50 ms per outer iteration guards against the busy-spin the Node client hit live.
  - `grid` is a provider, read each iteration, so a grid that finishes loading mid-walk is used from the next step.

- [ ] **Step 1: Write the failing tests**

```kotlin
package app.workadventurer.nav

import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeSink(start: Pt) : MovementSink {
    class Move(val x: Double, val y: Double, val facing: Facing, val moving: Boolean)

    var pos = start
    val moves = mutableListOf<Move>()
    override fun position() = pos
    override fun move(x: Double, y: Double, facing: Facing, moving: Boolean) {
        pos = Pt(x, y)
        moves += Move(x, y, facing, moving)
    }
}

class NavigatorTest {
    @Test
    fun walkToArrivesInStepsNoLargerThanStepPxAndEndsStopped() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        assertEquals(Outcome.ARRIVED, nav.walkTo(Pt(320.0, 0.0), stopWithin = 12.0, stepPx = 32.0))
        var prev = Pt(0.0, 0.0)
        for (m in sink.moves.filter { it.moving }) {
            assertTrue(hypot(m.x - prev.x, m.y - prev.y) <= 32.0 + 1e-6)
            prev = Pt(m.x, m.y)
        }
        assertTrue(sink.pos.x >= 308.0)
        assertFalse(sink.moves.last().moving)
        assertEquals(Facing.RIGHT, sink.moves.last().facing)
        assertEquals(1, sink.moves.count { !it.moving }, "exactly one final stop")
    }

    @Test
    fun walkToStopsWhenTheTargetIsGone() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        var calls = 0
        val r = nav.walkTo(Pt(0.0, 0.0), getTarget = { if (calls++ < 3) Pt(500.0, 0.0) else null })
        assertEquals(Outcome.TARGET_GONE, r)
        assertFalse(sink.moves.last().moving)
    }

    @Test
    fun walkToTimesOutAndStillSendsAFinalStop() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        assertEquals(Outcome.TIMEOUT, nav.walkTo(Pt(100_000.0, 0.0), timeoutMs = 500))
        assertFalse(sink.moves.last().moving)
    }

    @Test
    fun cancellingMidWalkSendsAFinalStop() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        val job = launch { nav.walkTo(Pt(100_000.0, 0.0)) }
        advanceTimeBy(500); runCurrent()
        assertTrue(sink.moves.last().moving)
        job.cancel(); runCurrent()
        assertFalse(sink.moves.last().moving)
    }

    private val wallWithGap = gridOf(
        ".......#......",
        ".......#......",
        ".......#......",
        ".......#......",
        ".......#......",
        "..............",
        "..............",
    )

    @Test
    fun navToRoutesAroundAWallAndNeverStepsIntoOne() = runTest {
        val g = wallWithGap
        val start = g.tileCenterPx(1, 2)
        val sink = FakeSink(start)
        val nav = Navigator({ g }, sink, { testScheduler.currentTime })
        val goal = g.tileCenterPx(12, 2)
        assertEquals(Outcome.ARRIVED, nav.navTo(goal, stopWithin = 24.0))
        for (m in sink.moves) assertFalse(g.isPxBlocked(m.x, m.y), "stepped into a wall at ${m.x},${m.y}")
        assertTrue(hypot(sink.pos.x - goal.x, sink.pos.y - goal.y) <= 24.0)
        assertFalse(sink.moves.last().moving)
    }

    @Test
    fun navToFacesTheGivenPointOnArrival() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        nav.navTo(Pt(100.0, 0.0), stopWithin = 12.0, face = { Pt(100.0, 500.0) })
        assertEquals(Facing.DOWN, sink.moves.last().facing)
        assertFalse(sink.moves.last().moving)
    }

    @Test
    fun navToWithNoPathDegradesToStraightLineAndTerminates() = runTest {
        // start sealed in a pocket: A* finds nothing, so we walk straight (through the wall) rather than spin or give up
        val g = gridOf("#####", "#.#..", "#####")
        val sink = FakeSink(g.tileCenterPx(1, 1))
        val nav = Navigator({ g }, sink, { testScheduler.currentTime })
        assertEquals(Outcome.ARRIVED, nav.navTo(g.tileCenterPx(4, 1), stopWithin = 12.0))
        assertTrue(sink.moves.isNotEmpty())
    }

    @Test
    fun navToNeverSpinsWhenTheGoalIsUnreachableInTime() = runTest {
        // no grid and a goal 100 km away: must hit the timeout with a bounded number of messages (one per tick), not spin
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        assertEquals(Outcome.TIMEOUT, nav.navTo(Pt(100_000.0, 0.0), timeoutMs = 2_000))
        assertTrue(sink.moves.size < 40, "sent ${sink.moves.size} messages in 2 s of virtual time")
    }

    @Test
    fun navToStopsWhenTheTargetIsGone() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        var calls = 0
        val r = nav.navTo(Pt(0.0, 0.0), getTarget = { if (calls++ < 2) Pt(5_000.0, 0.0) else null })
        assertEquals(Outcome.TARGET_GONE, r)
    }

    @Test
    fun followConvergesToSpacingShortOfTheTargetAndStops() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        val target = Target(300.0, 0.0, Facing.LEFT)
        val job = launch { nav.follow({ target }, spacing = 72.0, stepPx = 30.0, tickMs = 100) }
        advanceTimeBy(10_000); runCurrent()
        assertTrue(abs(sink.pos.x - 228.0) <= 20.0, "ended at ${sink.pos}")
        assertFalse(sink.moves.last().moving, "must stop when it arrives, not wait for a keepalive")
        assertEquals(Facing.RIGHT, sink.moves.last().facing) // looking at the target
        job.cancel()
    }

    @Test
    fun followEndsWhenTheTargetDisappears() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        var present = true
        // 5000 px away: at 30 px per 100 ms the avatar is still walking after 3 s
        val result = async { nav.follow({ if (present) Target(5_000.0, 0.0, Facing.DOWN) else null }) }
        advanceTimeBy(3_000); runCurrent()
        assertTrue(sink.moves.last().moving)
        present = false
        advanceTimeBy(500); runCurrent()
        assertEquals(Outcome.TARGET_GONE, result.await())
        assertFalse(sink.moves.last().moving)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :nav:test --tests '*NavigatorTest*'`
Expected: FAIL (unresolved `Navigator`, `MovementSink`, `Outcome`).

- [ ] **Step 3: Implement `Navigator.kt`**

```kotlin
package app.workadventurer.nav

import kotlinx.coroutines.delay
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** Where the avatar is and how to move it. The live connection implements this; tests fake it. */
interface MovementSink {
    fun position(): Pt
    fun move(x: Double, y: Double, facing: Facing, moving: Boolean)
}

enum class Outcome { ARRIVED, TIMEOUT, TARGET_GONE }

private const val MIN_ITER_MS = 50L

/**
 * Moves an avatar through a [MovementSink]. Port of walkTo/navTo/follow in src/wa-client.mjs, with
 * cancellation instead of an AbortSignal and one final "stopped" message per call instead of one per waypoint.
 */
class Navigator(
    private val grid: () -> NavGrid?,
    private val sink: MovementSink,
    private val nowMs: () -> Long,
) {
    private var facing = Facing.DOWN
    private var moving = false

    private fun emit(x: Double, y: Double, f: Facing, isMoving: Boolean) {
        facing = f
        moving = isMoving
        sink.move(x, y, f, isMoving)
    }

    /** Sends the final "stopped" message if we were moving (or need to turn); a no-op otherwise. */
    private fun stop(lookAt: Facing? = null) {
        if (!moving && lookAt == null) return
        val p = sink.position()
        emit(p.x, p.y, lookAt ?: facing, false)
    }

    /** Steps toward [t] until within [stopWithin] (true) or [deadline] passes (false). Sends no stop. */
    private suspend fun walkLeg(t: Pt, stopWithin: Double, stepPx: Double, tickMs: Long, deadline: Long): Boolean {
        while (true) {
            val p = sink.position()
            val dx = t.x - p.x
            val dy = t.y - p.y
            val dist = hypot(dx, dy)
            if (dist <= stopWithin) return true
            if (nowMs() > deadline) return false
            val step = min(stepPx, dist)
            emit(p.x + dx / dist * step, p.y + dy / dist * step, faceToward(p.x, p.y, t.x, t.y), true)
            delay(tickMs)
        }
    }

    suspend fun walkTo(
        target: Pt,
        stopWithin: Double = 48.0,
        stepPx: Double = 32.0,
        tickMs: Long = 120,
        timeoutMs: Long = 60_000,
        getTarget: (() -> Pt?)? = null,
    ): Outcome {
        val deadline = nowMs() + timeoutMs
        try {
            while (true) {
                if (nowMs() > deadline) return Outcome.TIMEOUT
                val t = if (getTarget != null) (getTarget() ?: return Outcome.TARGET_GONE) else target
                val p = sink.position()
                val dx = t.x - p.x
                val dy = t.y - p.y
                val dist = hypot(dx, dy)
                if (dist <= stopWithin) return Outcome.ARRIVED
                val step = min(stepPx, dist)
                emit(p.x + dx / dist * step, p.y + dy / dist * step, faceToward(p.x, p.y, t.x, t.y), true)
                delay(tickMs)
            }
        } finally {
            stop()
        }
    }

    suspend fun navTo(
        target: Pt,
        stopWithin: Double = 48.0,
        getTarget: (() -> Pt?)? = null,
        face: (() -> Pt?)? = null,
        timeoutMs: Long = 120_000,
        repathMs: Long = 2_000,
    ): Outcome {
        val started = nowMs()
        try {
            while (nowMs() - started < timeoutMs) {
                val iterStart = nowMs()
                val t = if (getTarget != null) (getTarget() ?: return Outcome.TARGET_GONE) else target
                val p = sink.position()
                if (hypot(t.x - p.x, t.y - p.y) <= stopWithin) {
                    stop(lookAt = face?.invoke()?.let { faceToward(p.x, p.y, it.x, it.y) })
                    return Outcome.ARRIVED
                }
                val deadline = iterStart + repathMs
                val path = grid()?.findPath(p, t)
                if (path.isNullOrEmpty()) {
                    // no grid yet, or no route: walk straight toward the goal for this window, then try again
                    walkLeg(t, stopWithin, 32.0, 120, deadline)
                } else {
                    for (wp in path) {
                        if (nowMs() > deadline) break
                        if (!walkLeg(wp, 12.0, 40.0, 100, deadline)) break
                    }
                }
                // Defence in depth: whatever happened above, never spin. (Node hit a live 100% CPU / growing-RSS
                // spin when every leg returned "already arrived" without ever sleeping.)
                val elapsed = nowMs() - iterStart
                if (elapsed < MIN_ITER_MS) delay(MIN_ITER_MS - elapsed)
            }
            return Outcome.TIMEOUT
        } finally {
            stop()
        }
    }

    suspend fun follow(
        getTarget: () -> Target?,
        spacing: Double = 72.0,
        tickMs: Long = 100,
        stepPx: Double = 30.0,
        arriveSlack: Double = 20.0,
    ): Outcome {
        var path: ArrayDeque<Pt>? = null
        var pathAt = 0L
        var pathGoal: Pt? = null
        try {
            while (true) {
                val target = getTarget() ?: return Outcome.TARGET_GONE
                val me = sink.position()
                val goal = followPoint(me, Pt(target.x, target.y), spacing, grid())
                val dGoal = hypot(goal.x - me.x, goal.y - me.y)

                if (dGoal <= arriveSlack) {
                    val f = faceToward(me.x, me.y, target.x, target.y)
                    if (moving || f != facing) emit(me.x, me.y, f, false)
                    path = null
                    delay(tickMs * 2)
                    continue
                }

                val pg = pathGoal
                val stale = path == null || path.isEmpty() || nowMs() - pathAt > 700 ||
                    pg == null || hypot(pg.x - goal.x, pg.y - goal.y) > 80
                if (stale) {
                    val raw = grid()?.findPath(me, goal)
                    path = ArrayDeque(if (!raw.isNullOrEmpty()) raw else listOf(goal))
                    pathAt = nowMs()
                    pathGoal = goal
                }
                val q = path!!
                var wp = q.first()
                var dwp = hypot(wp.x - me.x, wp.y - me.y)
                while (dwp <= stepPx && q.size > 1) {
                    q.removeFirst()
                    wp = q.first()
                    dwp = hypot(wp.x - me.x, wp.y - me.y)
                }
                val step = min(stepPx, max(dwp, dGoal))
                val nx = if (dwp > 0.001) me.x + (wp.x - me.x) / dwp * step else me.x
                val ny = if (dwp > 0.001) me.y + (wp.y - me.y) / dwp * step else me.y
                emit(nx, ny, faceToward(me.x, me.y, wp.x, wp.y), true)
                delay(tickMs)
            }
        } finally {
            stop()
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :nav:test`
Expected: PASS. A hang in `runTest` means a loop with no `delay` on some path: that is exactly the bug class Review Focus 1 is about; find the path, don't raise the timeout.

- [ ] **Step 5: Commit**

```bash
git add android
git commit -m "feat(android): Navigator (walkTo/navTo/follow) over a MovementSink

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Pose in `RoomState`, facing mapping

**Files:**
- Modify: `android/protocol/src/main/kotlin/app/workadventurer/protocol/RoomState.kt`
- Create: `android/protocol/src/main/kotlin/app/workadventurer/protocol/FacingMapping.kt`
- Modify: `android/nav/src/main/kotlin/app/workadventurer/nav/Steering.kt` (make `snapped` public as `snapToFree`, see below)
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/RoomStateTest.kt` (append), `android/protocol/src/test/kotlin/app/workadventurer/protocol/FacingMappingTest.kt`, `android/nav/src/test/kotlin/app/workadventurer/nav/SteeringTest.kt` (append)

**Interfaces:**
- Produces:
  - `data class Pose(val x: Double, val y: Double, val facing: Facing)`; `RoomState.myPose: StateFlow<Pose>`; `fun setMyPose(x: Double, y: Double, facing: Facing)`; existing `setMyPosition(x: Int, y: Int)` keeps the facing; `myPosition(): Pair<Int, Int>` now returns the **rounded** pose; `currentAreas()` uses it. The old private `Pair` field is gone.
  - `fun Facing.toDirection(): PositionMessage.Direction`, `fun PositionMessage.Direction.toFacing(): Facing`.
  - `fun NavGrid.snapToFree(x: Double, y: Double): Pt?` in `Steering.kt`: the point itself if free, else the centre of the nearest free tile, else null (was the private `snapped`).

- [ ] **Step 1: Write the failing tests**

Append to `RoomStateTest` (add `import app.workadventurer.nav.Facing`):

```kotlin
    @Test
    fun poseFlowFollowsMovesRoundsForTheWireAndFeedsCurrentAreas() {
        val s = RoomState()
        s.areas = listOf(
            Area("a", "A", 0, 0, 100, 100, emptySet(), false, false),
            Area("b", "B", 500, 500, 10, 10, emptySet(), false, false),
        )
        s.setMyPose(50.4, 50.6, Facing.LEFT)
        assertEquals(Pose(50.4, 50.6, Facing.LEFT), s.myPose.value)
        assertEquals(50 to 51, s.myPosition())
        assertEquals(listOf("A"), s.currentAreas().map { it.name })
        s.setMyPose(505.0, 505.0, Facing.UP)
        assertEquals(listOf("B"), s.currentAreas().map { it.name })
    }

    @Test
    fun setMyPositionKeepsTheFacing() {
        val s = RoomState()
        s.setMyPose(1.0, 2.0, Facing.LEFT)
        s.setMyPosition(10, 20)
        assertEquals(Pose(10.0, 20.0, Facing.LEFT), s.myPose.value)
    }
```

`FacingMappingTest.kt`:

```kotlin
package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.proto.PositionMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class FacingMappingTest {
    @Test
    fun everyFacingRoundTripsThroughTheWireEnum() {
        for (f in Facing.entries) assertEquals(f, f.toDirection().toFacing())
        assertEquals(PositionMessage.Direction.LEFT, Facing.LEFT.toDirection())
        assertEquals(Facing.DOWN, PositionMessage.Direction.DOWN.toFacing())
    }
}
```

Append to `SteeringTest`:

```kotlin
    @Test
    fun snapToFreeReturnsTheSamePointWhenFreeAndAFreeTileCentreWhenBlocked() {
        val g = gridOf("...", ".#.", "...")
        assertEquals(Pt(10.0, 10.0), g.snapToFree(10.0, 10.0))
        val s = g.snapToFree(48.0, 48.0)!! // the blocked middle tile
        assertTrue(!g.isPxBlocked(s.x, s.y))
        assertEquals(null, NavGrid(2, 2, 32, BooleanArray(4) { true }).snapToFree(10.0, 10.0))
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :nav:test :protocol:test`
Expected: FAIL (unresolved `Pose`, `setMyPose`, `toDirection`, `snapToFree`).

- [ ] **Step 3: Implement**

In `Steering.kt` rename the private helper and make it public (and update its two call sites):

```kotlin
/** The point itself if it's on a free tile, else the centre of the nearest free tile, else null. */
fun NavGrid.snapToFree(x: Double, y: Double): Pt? {
    if (!isPxBlocked(x, y)) return Pt(x, y)
    val (tx, ty) = pxToTile(x, y)
    val free = nearestFree(tx, ty) ?: return null
    return tileCenterPx(free.first, free.second)
}
```

`FacingMapping.kt`:

```kotlin
package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.proto.PositionMessage

fun Facing.toDirection(): PositionMessage.Direction = when (this) {
    Facing.UP -> PositionMessage.Direction.UP
    Facing.RIGHT -> PositionMessage.Direction.RIGHT
    Facing.DOWN -> PositionMessage.Direction.DOWN
    Facing.LEFT -> PositionMessage.Direction.LEFT
}

fun PositionMessage.Direction.toFacing(): Facing = when (this) {
    PositionMessage.Direction.UP -> Facing.UP
    PositionMessage.Direction.RIGHT -> Facing.RIGHT
    PositionMessage.Direction.DOWN -> Facing.DOWN
    PositionMessage.Direction.LEFT -> Facing.LEFT
}
```

In `RoomState.kt`: add `import app.workadventurer.nav.Facing` and `import kotlin.math.roundToInt`, add the `Pose` class next to `Player`, delete the `@Volatile private var pos = 0 to 0` field, and replace the three position members:

```kotlin
data class Pose(val x: Double, val y: Double, val facing: Facing)

// inside class RoomState:
    private val _pose = MutableStateFlow(Pose(0.0, 0.0, Facing.DOWN))
    val myPose: StateFlow<Pose> = _pose.asStateFlow()

    fun setMyPose(x: Double, y: Double, facing: Facing) { _pose.value = Pose(x, y, facing) }
    fun setMyPosition(x: Int, y: Int) { _pose.update { it.copy(x = x.toDouble(), y = y.toDouble()) } }

    /** The pose rounded to whole pixels, as it goes on the wire. */
    fun myPosition(): Pair<Int, Int> = _pose.value.let { it.x.roundToInt() to it.y.roundToInt() }
    fun currentAreas(): List<Area> = myPosition().let { (px, py) -> areas.filter { it.contains(px, py) } }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :nav:test :protocol:test`
Expected: PASS. (`PusherConnection` still calls `state.myPosition()`/`setMyPosition`, which keep working.)

- [ ] **Step 5: Commit**

```bash
git add android
git commit -m "feat(android): avatar pose + facing mapping in RoomState

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `fetchWamJson` and `loadNavGrid` (tmj download, disk cache)

**Files:**
- Modify: `android/protocol/src/main/kotlin/app/workadventurer/protocol/Areas.kt`
- Create: `android/protocol/src/main/kotlin/app/workadventurer/protocol/NavGridLoader.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/NavGridLoaderTest.kt`

**Interfaces:**
- Consumes: `CollisionBuilder`, `NavGrid` (Tasks 0, 3); `RoomConfig`, `Wa133.MAP` (G0).
- Produces:
  - `suspend fun fetchWamJson(http: OkHttpClient, cfg: RoomConfig): String?`: `/map?playUri=` → `wamUrl` → the `.wam` text; null on any failure (never throws except cancellation). `loadAreas` now calls it (behaviour and tests unchanged).
  - `suspend fun loadNavGrid(http: OkHttpClient, wamJson: String, cacheDir: File? = null, nowMs: () -> Long = System::currentTimeMillis, ttlMs: Long = 24h): NavGrid?`: reads `mapUrl` from the `.wam`, fetches the `.tmj` (cached on disk under `cacheDir` as `<sha1(url)>.tmj`; a cache younger than `ttlMs` is used without any request; **a stale cache is used when the refetch fails**), builds the grid. Null when there is no `mapUrl`, the download fails with no cache, or the `.tmj` is unusable. Never throws except cancellation.

- [ ] **Step 1: Write the failing tests**

```kotlin
package app.workadventurer.protocol

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class NavGridLoaderTest {
    private val tmj = """{"width":4,"height":3,"tilewidth":32,"tilesets":[],"layers":[
        {"type":"tilelayer","name":"collisions","data":[0,1,0,0, 0,0,0,0, 0,0,0,1]}]}"""

    private class Site(val server: MockWebServer, val tmjRequests: AtomicInteger) {
        @Volatile var tmjOk = true
        val base get() = server.url("/").toString().trimEnd('/')
        fun wam(withMapUrl: Boolean = true) =
            if (withMapUrl) """{"mapUrl":"$base/the.tmj","entities":{},"areas":[]}""" else """{"entities":{}}"""
    }

    private fun site(tmj: String): Site {
        val server = MockWebServer()
        val count = AtomicInteger()
        lateinit var site: Site
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/the.tmj" -> {
                    count.incrementAndGet()
                    if (site.tmjOk) MockResponse().setBody(tmj) else MockResponse().setResponseCode(500)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        site = Site(server, count)
        return site
    }

    private fun tempDir(): File = Files.createTempDirectory("navcache").toFile()

    @Test
    fun buildsAGridFromTheWamsMapUrl() = runTest {
        val s = site(tmj)
        s.server.use {
            val g = loadNavGrid(OkHttpClient(), s.wam())!!
            assertEquals(listOf(1, 11), g.blockedIndices().toList())
            assertEquals(4, g.w); assertEquals(3, g.h)
        }
    }

    @Test
    fun noMapUrlGivesNull() = runTest {
        val s = site(tmj)
        s.server.use { assertNull(loadNavGrid(OkHttpClient(), s.wam(withMapUrl = false))) }
    }

    @Test
    fun aFailedDownloadWithoutACacheGivesNull() = runTest {
        val s = site(tmj)
        s.tmjOk = false
        s.server.use { assertNull(loadNavGrid(OkHttpClient(), s.wam())) }
    }

    @Test
    fun aGarbledWamGivesNullInsteadOfThrowing() = runTest {
        assertNull(loadNavGrid(OkHttpClient(), "{{{ not json"))
    }

    @Test
    fun aSecondCallWithinTheTtlUsesTheDiskCache() = runTest {
        val dir = tempDir()
        val s = site(tmj)
        try {
            s.server.use {
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir))
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir))
                assertEquals(1, s.tmjRequests.get(), "second call must not hit the network")
            }
        } finally { dir.deleteRecursively() }
    }

    @Test
    fun anExpiredCacheIsRefetched() = runTest {
        val dir = tempDir()
        val s = site(tmj)
        try {
            s.server.use {
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir))
                val later = { System.currentTimeMillis() + 25L * 3_600_000 }
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir, nowMs = later))
                assertEquals(2, s.tmjRequests.get())
            }
        } finally { dir.deleteRecursively() }
    }

    @Test
    fun aStaleCacheBeatsNothingWhenTheRefetchFails() = runTest {
        val dir = tempDir()
        val s = site(tmj)
        try {
            s.server.use {
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir))
                s.tmjOk = false
                val later = { System.currentTimeMillis() + 25L * 3_600_000 }
                val g = loadNavGrid(OkHttpClient(), s.wam(), dir, nowMs = later)
                assertNotNull(g, "should fall back to the stale cache")
                assertEquals(2, s.tmjRequests.get())
            }
        } finally { dir.deleteRecursively() }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :protocol:test --tests '*NavGridLoaderTest*'`
Expected: FAIL (unresolved `loadNavGrid`).

- [ ] **Step 3: Implement**

In `Areas.kt` replace `loadAreas` with `fetchWamJson` + a thin `loadAreas` (keep `parseWam`, `pickSpawn`, the data classes unchanged; add `import kotlinx.coroutines.CancellationException`):

```kotlin
/** Best-effort: the room's `.wam` as JSON text, or null on any failure (a join must work without it). */
suspend fun fetchWamJson(http: OkHttpClient, cfg: RoomConfig): String? = withContext(Dispatchers.IO) {
    try {
        val mapUrl = (cfg.pusherUrl + Wa133.MAP).toHttpUrl().newBuilder()
            .addQueryParameter("playUri", cfg.roomUrl).build()
        fun get(url: String): String = http.newCall(Request.Builder().url(url).build()).execute().use {
            check(it.isSuccessful) { "HTTP ${it.code}" }
            it.body!!.string()
        }
        val wamUrl = Json.parseToJsonElement(get(mapUrl.toString())).jsonObject["wamUrl"]
            ?.jsonPrimitive?.contentOrNull ?: return@withContext null
        get(wamUrl)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}

/** Best-effort: any failure yields an empty list. */
suspend fun loadAreas(http: OkHttpClient, cfg: RoomConfig): List<Area> =
    fetchWamJson(http, cfg)?.let { try { parseWam(it) } catch (e: Exception) { emptyList() } } ?: emptyList()
```

`NavGridLoader.kt`:

```kotlin
package app.workadventurer.protocol

import app.workadventurer.nav.CollisionBuilder
import app.workadventurer.nav.NavGrid
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

private const val DAY_MS = 24L * 3_600_000

/**
 * Builds the room's [NavGrid] from its `.wam` (already fetched) and the `.tmj` it points at. The `.tmj` is
 * ~1.5 MB, so it is cached on disk; a stale cache is used if the refetch fails. Null if anything is unusable.
 */
suspend fun loadNavGrid(
    http: OkHttpClient,
    wamJson: String,
    cacheDir: File? = null,
    nowMs: () -> Long = System::currentTimeMillis,
    ttlMs: Long = DAY_MS,
): NavGrid? = withContext(Dispatchers.IO) {
    try {
        val mapUrl = Json.parseToJsonElement(wamJson).jsonObject["mapUrl"]?.jsonPrimitive?.contentOrNull
            ?: return@withContext null
        val tmj = tmjText(http, mapUrl, cacheDir, nowMs, ttlMs) ?: return@withContext null
        CollisionBuilder.build(wamJson, tmj)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}

private fun tmjText(http: OkHttpClient, url: String, cacheDir: File?, nowMs: () -> Long, ttlMs: Long): String? {
    val file = cacheDir?.let { File(it, sha1(url) + ".tmj") }
    val cached = file?.takeIf { it.isFile }
    if (cached != null && nowMs() - cached.lastModified() < ttlMs) return cached.readText()

    val fresh = try {
        http.newCall(Request.Builder().url(url).build()).execute().use {
            if (it.isSuccessful) it.body?.string() else null
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
    if (fresh != null) {
        if (file != null) runCatching {
            file.parentFile.mkdirs()
            val tmp = File(file.parentFile, file.name + ".part")
            tmp.writeText(fresh)
            tmp.renameTo(file)
        }
        return fresh
    }
    return cached?.readText() // a stale map beats no map
}

private fun sha1(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :protocol:test`
Expected: PASS (the existing `AreasTest` still passes through the new `loadAreas`).

- [ ] **Step 5: Commit**

```bash
git add android
git commit -m "feat(android): fetchWamJson + loadNavGrid with a disk-cached .tmj

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `PusherConnection` as a `MovementSink` (move, background grid, spawn nudge)

**Files:**
- Modify: `android/protocol/src/main/kotlin/app/workadventurer/protocol/PusherConnection.kt`
- Test: `android/protocol/src/test/kotlin/app/workadventurer/protocol/PusherConnectionTest.kt` (append)

**Interfaces:**
- Consumes: `MovementSink`, `NavGrid`, `Pt`, `Facing` (Tasks 0, 4); `Pose`, `toDirection` (Task 5); `fetchWamJson`, `loadNavGrid` (Task 6).
- Produces on `PusherConnection` (still `open`; overrides are open for test fakes): `: MovementSink`; `override fun position(): Pt`; `override fun move(x: Double, y: Double, facing: Facing, moving: Boolean)` (updates the pose, sends a `userMovesMessage` with the rounded position, the facing, `moving`, and a viewport centred on it); `open val grid: StateFlow<NavGrid?>` (null until the background load finishes; stays null if it fails); constructor param `cacheDir: File? = null` (last). Behaviour: the grid load starts **after** `roomJoinedMessage`, never delays `connect()`; once it arrives, if the avatar's tile is blocked it is moved to the nearest free tile; the keepalive and join messages carry the current **facing**, not a hard-coded `DOWN`.

- [ ] **Step 1: Write the failing tests**

Append to `PusherConnectionTest` (add `import app.workadventurer.nav.Facing`, `import app.workadventurer.nav.Pt`, `import app.workadventurer.proto.PositionMessage` is already imported, `import java.nio.file.Files`, `import java.util.concurrent.atomic.AtomicInteger`):

```kotlin
    /** A pusher that also serves /map -> wam -> tmj, so the background grid load can run. */
    private fun serverWithMap(fake: Fake, tmj: String?, tmjRequests: AtomicInteger = AtomicInteger()): MockWebServer {
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val base = s.url("/").toString().trimEnd('/')
                return when {
                    request.path!!.startsWith("/anonymLogin") -> MockResponse().setBody("""{"authToken":"TOK","userUuid":"me"}""")
                    request.path!!.startsWith("/map") -> MockResponse().setBody("""{"wamUrl":"$base/the.wam"}""")
                    request.path == "/the.wam" -> MockResponse().setBody("""{"mapUrl":"$base/the.tmj","entities":{},"areas":[]}""")
                    request.path == "/the.tmj" -> {
                        tmjRequests.incrementAndGet()
                        if (tmj != null) MockResponse().setBody(tmj) else MockResponse().setResponseCode(500)
                    }
                    request.path!!.startsWith("/ws/room") -> { fake.upgradeRequest = request; MockResponse().withWebSocketUpgrade(fake.listener) }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        s.start()
        return s
    }

    private fun joiningFake() = Fake(
        onOpen = { ws -> ws.send(s2c(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))) },
        onFrame = { ws, msg ->
            if (msg.joinRoomFrontMessage != null)
                ws.send(s2c(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 7))))
        },
    )

    // 12 x 12 map; tile (10,10) is blocked, and (10,10) is exactly where the (320,320) fallback spawn lands.
    private val spawnBlockedTmj = """{"width":12,"height":12,"tilewidth":32,"tilesets":[],"layers":[
        {"type":"tilelayer","name":"collisions","data":[${(0 until 144).joinToString(",") { if (it == 10 * 12 + 10) "1" else "0" }}]}]}"""

    @Test
    fun moveSendsTheRoundedPositionFacingAndMovingAndUpdatesThePose() = runBlocking {
        val fake = joiningFake()
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            fake.received.poll(2, TimeUnit.SECONDS) // the join message
            conn.move(100.4, 200.6, Facing.LEFT, true)
            val m = generateSequence { fake.received.poll(2, TimeUnit.SECONDS) }.first { it.userMovesMessage != null }.userMovesMessage!!
            assertEquals(100, m.position!!.x)
            assertEquals(201, m.position!!.y)
            assertEquals(PositionMessage.Direction.LEFT, m.position!!.direction)
            assertTrue(m.position!!.moving)
            assertEquals(Pt(100.4, 200.6), conn.position())
            assertEquals(Facing.LEFT, conn.state.myPose.value.facing)
            conn.close()
        }
    }

    @Test
    fun theKeepAliveCarriesTheLatestFacingNotAlwaysDown() = runBlocking {
        val fake = joiningFake()
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 50)
            withTimeout(5_000) { conn.connect() }
            conn.move(10.0, 10.0, Facing.LEFT, false)
            delay(300)
            val last = generateSequence { fake.received.poll(300, TimeUnit.MILLISECONDS) }
                .mapNotNull { it.userMovesMessage }.last()
            assertEquals(PositionMessage.Direction.LEFT, last.position!!.direction)
            conn.close()
        }
    }

    @Test
    fun theGridLoadsInTheBackgroundAfterTheJoin() = runBlocking {
        val fake = joiningFake()
        serverWithMap(fake, spawnBlockedTmj).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            withTimeout(5_000) { while (conn.grid.value == null) delay(10) }
            val g = conn.grid.value!!
            assertEquals(12, g.w)
            assertTrue(g.isTileBlocked(10, 10))
            conn.close()
        }
    }

    @Test
    fun aFailedMapDownloadLeavesTheGridNullAndTheJoinIntact() = runBlocking {
        val fake = joiningFake()
        serverWithMap(fake, tmj = null).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertEquals(7, conn.state.myUserId.value)
            delay(400)
            assertNull(conn.grid.value)
            conn.close()
        }
    }

    @Test
    fun aSpawnInsideAWallIsNudgedToAFreeTileOnceTheGridArrives() = runBlocking {
        val fake = joiningFake()
        serverWithMap(fake, spawnBlockedTmj).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            withTimeout(5_000) { while (conn.grid.value == null) delay(10) }
            val g = conn.grid.value!!
            withTimeout(5_000) { while (g.isPxBlocked(conn.position().x, conn.position().y)) delay(10) }
            val p = conn.position()
            assertTrue(!g.isPxBlocked(p.x, p.y), "still in the wall at $p")
            // and it was told to the server, not just remembered locally
            val sent = generateSequence { fake.received.poll(500, TimeUnit.MILLISECONDS) }
                .mapNotNull { it.userMovesMessage?.position }.toList()
            assertTrue(sent.any { !g.isPxBlocked(it.x.toDouble(), it.y.toDouble()) }, "no free-tile position was sent: $sent")
            conn.close()
        }
    }

    @Test
    fun theTmjIsCachedOnDiskBetweenConnections() = runBlocking {
        val dir = Files.createTempDirectory("navcache").toFile()
        val fake = joiningFake()
        val tmjRequests = AtomicInteger()
        try {
            serverWithMap(fake, spawnBlockedTmj, tmjRequests).use { s ->
                repeat(2) {
                    val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, cacheDir = dir)
                    withTimeout(5_000) { conn.connect() }
                    withTimeout(5_000) { while (conn.grid.value == null) delay(10) }
                    conn.close()
                }
                assertEquals(1, tmjRequests.get())
            }
        } finally { dir.deleteRecursively() }
    }
```

(Add `import okhttp3.mockwebserver.Dispatcher`/`RecordedRequest` if not already present; they are, from the existing `server()` helper. `assertNull` needs `import kotlin.test.assertNull`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :protocol:test --tests '*PusherConnectionTest*'`
Expected: FAIL (unresolved `move`, `grid`, `position`, `cacheDir`).

- [ ] **Step 3: Implement the changes in `PusherConnection.kt`**

1. Imports: `app.workadventurer.nav.Facing`, `app.workadventurer.nav.MovementSink`, `app.workadventurer.nav.NavGrid`, `app.workadventurer.nav.Pt`, `kotlinx.coroutines.flow.MutableStateFlow`, `kotlinx.coroutines.flow.StateFlow`, `kotlinx.coroutines.flow.asStateFlow`, `java.io.File`.
2. Class header: `open class PusherConnection(…, private val joinTimeoutMs: Long = 20_000, private val cacheDir: File? = null) : MovementSink {`.
3. New members (next to `closed`/`log`):

```kotlin
    private val _grid = MutableStateFlow<NavGrid?>(null)

    /** The room's collision grid: null until the background load finishes (and forever if it fails). */
    open val grid: StateFlow<NavGrid?> get() = _grid.asStateFlow()

    override fun position(): Pt = state.myPose.value.let { Pt(it.x, it.y) }

    override fun move(x: Double, y: Double, facing: Facing, moving: Boolean) {
        state.setMyPose(x, y, facing)
        send(ClientToServerMessage(userMovesMessage = UserMovesMessage(position = positionMessage(moving), viewport = viewport())))
    }

    private fun nudgeOffBlockedTile(g: NavGrid) {
        val p = position()
        if (!g.isPxBlocked(p.x, p.y)) return
        val (tx, ty) = g.pxToTile(p.x, p.y)
        val free = g.nearestFree(tx, ty) ?: return
        val c = g.tileCenterPx(free.first, free.second)
        _log.tryEmit("spawn tile is blocked; nudged to ${c.x.toInt()},${c.y.toInt()}")
        move(c.x, c.y, state.myPose.value.facing, false)
    }
```

4. Rename the private `position(moving: Boolean)` to `positionMessage(moving: Boolean)` and make it use the pose facing (update its two call sites, the join message and the keepalive):

```kotlin
    private fun positionMessage(moving: Boolean): PositionMessage {
        val (x, y) = state.myPosition()
        return PositionMessage(x = x, y = y, direction = state.myPose.value.facing.toDirection(), moving = moving)
    }
```

5. In `connect()`: replace `val areas = loadAreas(http, cfg)` with `val wam = fetchWamJson(http, cfg)` / `val areas = wam?.let { try { parseWam(it) } catch (e: Exception) { emptyList() } }.orEmpty()`, and **after** the `withTimeoutOrNull(joinTimeoutMs) { … }` join succeeds (still inside the `try`) start the background load:

```kotlin
            wam?.let { text ->
                scope.launch {
                    loadNavGrid(http, text, cacheDir)?.let { g ->
                        _grid.value = g
                        _log.tryEmit("nav grid ready (${g.w}x${g.h})")
                        nudgeOffBlockedTile(g)
                    } ?: _log.tryEmit("nav grid unavailable; movement stays straight-line")
                }
            }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :protocol:test`
Expected: PASS. The existing `PusherConnectionTest` cases are unaffected: their `/map` answers `{}` (no `wamUrl`), so `fetchWamJson` returns null and no grid load ever starts for them.

- [ ] **Step 5: Commit**

```bash
git add android
git commit -m "feat(android): PusherConnection as MovementSink, background nav grid, spawn nudge

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Movement `Command`s and `Activity` in `WaSession`

**Files:**
- Modify: `android/app/src/main/kotlin/app/workadventurer/app/session/WaSession.kt`
- Test: `android/app/src/test/kotlin/app/workadventurer/app/session/WaSessionTest.kt` (append and adjust `FakeConn`/`join`)

**Interfaces:**
- Consumes: `Navigator`, `Outcome`, `Target`, `Pt`, `frontOf`, `snapToFree` (Tasks 2, 4, 5); `PusherConnection.grid/position/move`, `Player.direction.toFacing()` (Tasks 5, 7).
- Produces: `Command.Follow(userId: Int)`, `Command.WalkToPlayer(userId: Int)`, `Command.WalkToArea(areaKey: String)` (`Area.id ?: Area.name`), `Command.StopMoving`; `sealed interface Activity { Idle; WalkingTo(label: String); Following(label: String) }`; `SessionState.activity: Activity = Activity.Idle`. Rules: movement commands are **ignored unless `Connected`**; a new movement replaces the current one; `Join`, `Leave`, a failed join and a dropped connection all cancel movement and reset `activity` to `Idle`; a finished walk (arrived / target gone) returns to `Idle`; `inAreas` updates as the avatar moves (the mirror now also reacts to pose changes).

- [ ] **Step 1: Write the failing tests**

First adjust the test file's helpers: give `join` position/facing parameters and teach `FakeConn` the movement members:

```kotlin
    private fun join(id: Int, name: String, x: Int = 1, y: Int = 2, dir: PositionMessage.Direction = PositionMessage.Direction.DOWN) = SubMessage(
        userJoinedMessage = UserJoinedMessage(userId = id, name = name, position = PositionMessage(x = x, y = y, direction = dir)),
    )

    private class FakeConn(cfg: RoomConfig, val behaviour: suspend FakeConn.() -> Unit) :
        PusherConnection(OkHttpClient(), cfg) {
        val fakeClosed = CompletableDeferred<Closed>()
        var closeCalls = 0
        val moves = mutableListOf<Triple<Double, Double, Boolean>>() // x, y, moving
        private val fakeGrid = MutableStateFlow<NavGrid?>(null)
        override val closed get() = fakeClosed
        override val grid: StateFlow<NavGrid?> get() = fakeGrid
        override suspend fun connect() = behaviour()
        override fun move(x: Double, y: Double, facing: Facing, moving: Boolean) {
            state.setMyPose(x, y, facing)
            moves += Triple(x, y, moving)
        }
        override fun close() { closeCalls++; fakeClosed.complete(Closed(1000, "bye")) }
    }
```

(imports: `app.workadventurer.nav.Facing`, `app.workadventurer.nav.NavGrid`, `kotlinx.coroutines.flow.MutableStateFlow`, `kotlinx.coroutines.flow.StateFlow`.) Then append the tests. A shared set-up helper keeps them short:

```kotlin
    /** A connected session with Ada (userId 1) standing at (300,0) facing LEFT, an area "Fire pit" around (250,50), us at the origin. */
    private fun TestScope.connected(): Pair<WaSession, () -> FakeConn> {
        var conn: FakeConn? = null
        val session = WaSession(
            backgroundScope,
            { c ->
                FakeConn(c) {
                    state.applySub(join(1, "Ada", x = 300, y = 0, dir = PositionMessage.Direction.LEFT))
                    state.areas = listOf(Area("fire", "Fire pit", 200, 0, 100, 100, emptySet(), false, false))
                    state.setMyPosition(0, 0)
                }.also { conn = it }
            },
            nowMs = { testScheduler.currentTime },
        )
        session.dispatch(Command.Join(cfg)); runCurrent()
        return session to { conn!! }
    }

    @Test
    fun followStartsReportsActivityAndWalksTowardThePlayer() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.Follow(1)); runCurrent()
        assertEquals(Activity.Following("Ada"), session.state.value.activity)
        advanceTimeBy(5_000); runCurrent()
        assertTrue(conn().moves.isNotEmpty())
        assertTrue(conn().state.myPose.value.x > 100.0, "should have walked toward Ada, at ${conn().state.myPose.value}")
        session.dispatch(Command.StopMoving); runCurrent()
    }

    @Test
    fun stopMovingGoesIdleWithAFinalStop() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.Follow(1)); advanceTimeBy(1_000); runCurrent()
        session.dispatch(Command.StopMoving); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        assertFalse(conn().moves.last().third, "last message must be a stop")
        val n = conn().moves.size
        advanceTimeBy(5_000); runCurrent()
        assertEquals(n, conn().moves.size, "no more moves after stopping")
    }

    @Test
    fun followEndsWhenThePlayerLeaves() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.Follow(1)); advanceTimeBy(1_000); runCurrent()
        conn().state.applySub(SubMessage(userLeftMessage = UserLeftMessage(userId = 1)))
        advanceTimeBy(1_000); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        assertFalse(conn().moves.last().third)
    }

    @Test
    fun walkToPlayerArrivesAndReturnsToIdle() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.WalkToPlayer(1)); runCurrent()
        assertEquals(Activity.WalkingTo("Ada"), session.state.value.activity)
        advanceTimeBy(20_000); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        val p = conn().state.myPose.value
        assertTrue(kotlin.math.hypot(p.x - 300.0, p.y) < 100.0, "should end near Ada, at $p")
    }

    @Test
    fun walkToAreaGoesToItsCentreAndAnUnknownAreaIsIgnored() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.WalkToArea("nope")); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        assertTrue(conn().moves.isEmpty())
        session.dispatch(Command.WalkToArea("fire")); runCurrent()
        assertEquals(Activity.WalkingTo("Fire pit"), session.state.value.activity)
        advanceTimeBy(20_000); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        val p = conn().state.myPose.value
        assertTrue(kotlin.math.hypot(p.x - 250.0, p.y - 50.0) <= 24.0, "should end at the centre, at $p")
        assertEquals(listOf("Fire pit"), session.state.value.inAreas.map { it.name })
    }

    @Test
    fun aNewMovementReplacesTheCurrentOne() = runTest {
        val (session, _) = connected()
        session.dispatch(Command.Follow(1)); runCurrent()
        session.dispatch(Command.WalkToArea("fire")); runCurrent()
        assertEquals(Activity.WalkingTo("Fire pit"), session.state.value.activity)
        session.dispatch(Command.StopMoving); runCurrent()
    }

    @Test
    fun leaveStopsMovementAndNothingIsSentAfterwards() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.Follow(1)); advanceTimeBy(1_000); runCurrent()
        session.dispatch(Command.Leave); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        val n = conn().moves.size
        advanceTimeBy(5_000); runCurrent()
        assertEquals(n, conn().moves.size, "the old connection kept getting positions after Leave")
    }

    @Test
    fun aDroppedConnectionStopsMovement() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.Follow(1)); advanceTimeBy(1_000); runCurrent()
        conn().fakeClosed.complete(Closed(1006, "net")); runCurrent()
        assertIs<Connection.Reconnecting>(session.state.value.connection)
        assertEquals(Activity.Idle, session.state.value.activity)
        val n = conn().moves.size
        advanceTimeBy(500); runCurrent() // before the reconnect creates a new FakeConn
        assertEquals(n, conn().moves.size)
    }

    @Test
    fun movementCommandsAreIgnoredUntilConnected() = runTest {
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { } }, nowMs = { testScheduler.currentTime })
        session.dispatch(Command.Follow(1)); runCurrent()          // not joined at all
        session.dispatch(Command.Join(cfg))                        // Connecting, connect() not yet run
        session.dispatch(Command.Follow(1)); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
    }
```

(imports: `app.workadventurer.proto.UserLeftMessage`, `kotlinx.coroutines.test.TestScope`, `kotlin.test.assertFalse`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*WaSessionTest*'`
Expected: FAIL (unresolved `Command.Follow`, `Activity`, …).

- [ ] **Step 3: Implement**

Edit `WaSession.kt` (imports: `app.workadventurer.nav.Navigator`, `Pt`, `Target`, `frontOf`, `snapToFree`, `app.workadventurer.protocol.toFacing`, `kotlinx.coroutines.flow.combine`):

1. Extend the model:

```kotlin
sealed interface Command {
    data class Join(val config: RoomConfig) : Command
    data object Leave : Command
    data class Follow(val userId: Int) : Command
    data class WalkToPlayer(val userId: Int) : Command
    data class WalkToArea(val areaKey: String) : Command // Area.id ?: Area.name
    data object StopMoving : Command
}

sealed interface Activity {
    data object Idle : Activity
    data class WalkingTo(val label: String) : Activity
    data class Following(val label: String) : Activity
}

// SessionState gains:  val activity: Activity = Activity.Idle,
```

2. Class state: `private var moveJob: Job? = null` and `private var moveSeq = 0`.

3. Replace `dispatch` and `stop` with:

```kotlin
    fun dispatch(cmd: Command) = synchronized(lock) {
        when (cmd) {
            is Command.Join -> {
                val gen = restart()
                // Set synchronously so observers never see the previous room's (or a stale Failed) state first.
                _state.value = SessionState(connection = Connection.Connecting, roomName = cmd.config.roomUrl)
                job = scope.launch { run(cmd.config, gen) }
            }
            Command.Leave -> { restart(); _state.value = SessionState() }
            is Command.Follow -> startMovement { c ->
                val p = c.state.players.value[cmd.userId] ?: return@startMovement null
                Plan(Activity.Following(label(p))) { nav -> nav.follow({ targetOf(c, cmd.userId) }) }
            }
            is Command.WalkToPlayer -> startMovement { c ->
                val p = c.state.players.value[cmd.userId] ?: return@startMovement null
                Plan(Activity.WalkingTo(label(p))) { nav ->
                    nav.navTo(
                        target = Pt(p.x.toDouble(), p.y.toDouble()),
                        stopWithin = 24.0,
                        getTarget = { targetOf(c, cmd.userId)?.let { frontOf(it, c.position(), 64.0, c.grid.value) } },
                        face = { targetOf(c, cmd.userId)?.let { Pt(it.x, it.y) } },
                    )
                }
            }
            is Command.WalkToArea -> startMovement { c ->
                val a = c.state.areas.firstOrNull { (it.id ?: it.name) == cmd.areaKey } ?: return@startMovement null
                Plan(Activity.WalkingTo(a.name)) { nav ->
                    val centre = Pt(a.x + a.w / 2.0, a.y + a.h / 2.0)
                    nav.navTo(c.grid.value?.snapToFree(centre.x, centre.y) ?: centre, stopWithin = 24.0)
                }
            }
            Command.StopMoving -> stopMovement()
        }
    }

    /** Ends the current presence run (and any movement) and returns the new generation. Caller holds [lock]. */
    private fun restart(): Int {
        generation++
        job?.cancel(); job = null
        conn?.close(); conn = null
        stopMovement()
        return generation
    }

    private class Plan(val activity: Activity, val run: suspend (Navigator) -> Unit)

    private fun label(p: Player) = p.name.ifBlank { "Unnamed player" }

    private fun targetOf(c: PusherConnection, userId: Int): Target? =
        c.state.players.value[userId]?.let { Target(it.x.toDouble(), it.y.toDouble(), it.direction.toFacing()) }

    /** Caller holds [lock]. Only while Connected; a new movement replaces the current one. */
    private fun startMovement(build: (PusherConnection) -> Plan?) {
        val c = conn ?: return
        if (_state.value.connection != Connection.Connected) return
        val plan = build(c) ?: return
        moveJob?.cancel()
        val id = ++moveSeq
        val gen = generation
        _state.update { it.copy(activity = plan.activity) }
        moveJob = scope.launch {
            try {
                plan.run(Navigator({ c.grid.value }, c, nowMs))
            } finally {
                synchronized(lock) {
                    if (gen == generation && id == moveSeq) {
                        moveJob = null
                        _state.update { it.copy(activity = Activity.Idle) }
                    }
                }
            }
        }
    }

    /** Caller holds [lock]. */
    private fun stopMovement() {
        moveSeq++
        moveJob?.cancel(); moveJob = null
        _state.update { it.copy(activity = Activity.Idle) }
    }
```

4. In `run`, the per-connection `finally { c.close(); c.state.clear() }` also stops movement for this generation: add `synchronized(lock) { if (gen == generation) stopMovement() }` as its first line.

5. Mirror both players **and** pose (so `inAreas` follows the avatar):

```kotlin
    private suspend fun mirrorState(c: PusherConnection, gen: Int) {
        combine(c.state.players, c.state.myPose) { players, _ -> players }.collect { map ->
            setState(gen) {
                it.copy(players = map.values.sortedBy { p -> p.name.lowercase() }, inAreas = c.state.currentAreas())
            }
        }
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :protocol:test :nav:test :app:testDebugUnitTest`
Expected: PASS. (The G1 tests still pass; `Connection.Connected` must be reached before a movement command is accepted: `connected()` runs `runCurrent()` after Join, and the movement tests assert it.)

- [ ] **Step 5: Commit**

```bash
git add android
git commit -m "feat(android): Follow / WalkToPlayer / WalkToArea / StopMoving commands

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: UI: row actions, activity line, Stop

**Files:**
- Modify: `android/app/src/main/kotlin/app/workadventurer/app/ui/PresenceFormat.kt`, `PresenceScreen.kt`, `android/app/src/main/kotlin/app/workadventurer/app/MainActivity.kt`
- Test: `android/app/src/test/kotlin/app/workadventurer/app/ui/PresenceFormatTest.kt` (append)

**Interfaces:**
- Consumes: `Activity`, `Command` (Task 8).
- Produces: `fun activityText(a: Activity): String?` (null for Idle); `PresenceScreen(state, onJoin, onLeave, onCommand: (Command) -> Unit, notice)`. Per player row: a **Follow** and a **Walk to** button; per area row: a **Walk to** button; while `activity != Idle` a status line plus a **Stop** button. All three are disabled unless `Connected`. Each button's `contentDescription` is the full action ("Follow Ada", "Walk to Fire pit", "Stop following Ada") for TalkBack; touch targets ≥ 48 dp.

- [ ] **Step 1: Write the failing test**

```kotlin
    @Test fun activityTextDescribesWhatTheAvatarIsDoing() {
        assertEquals(null, activityText(Activity.Idle))
        assertEquals("Following Ada", activityText(Activity.Following("Ada")))
        assertEquals("Walking to Fire pit", activityText(Activity.WalkingTo("Fire pit")))
    }
```

(`import app.workadventurer.app.session.Activity`)

- [ ] **Step 2: Run to verify it fails**, `cd android && ./gradlew :app:testDebugUnitTest --tests '*PresenceFormatTest*'`. Expected: FAIL (unresolved `activityText`).

- [ ] **Step 3: Implement**

`PresenceFormat.kt`: add

```kotlin
fun activityText(a: Activity): String? = when (a) {
    Activity.Idle -> null
    is Activity.Following -> "Following ${a.label}"
    is Activity.WalkingTo -> "Walking to ${a.label}"
}
```

`PresenceScreen.kt`: add the `onCommand: (Command) -> Unit` parameter (before `notice`), compute `val canMove = state.connection is Connection.Connected`, show under the status line

```kotlin
        activityText(state.activity)?.let { text ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(text, Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite })
                Button(
                    onClick = { onCommand(Command.StopMoving) },
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Stop. $text" },
                ) { Text("Stop") }
            }
        }
```

and replace the player and area `Text` rows with rows holding the label plus buttons:

```kotlin
            items(state.players, key = { it.userId }) { p ->
                val label = playerLabel(p)
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(label, Modifier.weight(1f).semantics { contentDescription = "Player $label" })
                    TextButton(
                        onClick = { onCommand(Command.Follow(p.userId)) }, enabled = canMove,
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Follow $label" },
                    ) { Text("Follow") }
                    TextButton(
                        onClick = { onCommand(Command.WalkToPlayer(p.userId)) }, enabled = canMove,
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Walk to $label" },
                    ) { Text("Walk to") }
                }
            }
            // …and for areas (key = a.id ?: a.name):
            items(state.areas, key = { it.id ?: it.name }) { a ->
                val here = state.inAreas.any { (it.id ?: it.name) == (a.id ?: a.name) }
                val text = if (here) "${a.name} (you are here)" else a.name
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(text, Modifier.weight(1f).semantics { contentDescription = "Area $text" })
                    TextButton(
                        onClick = { onCommand(Command.WalkToArea(a.id ?: a.name)) }, enabled = canMove,
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Walk to ${a.name}" },
                    ) { Text("Walk to") }
                }
            }
```

(imports: `androidx.compose.foundation.layout.Row`, `androidx.compose.material3.TextButton`, `androidx.compose.ui.Alignment`, `app.workadventurer.app.session.Command`.)

`MainActivity.kt`: pass `onCommand = { session.dispatch(it) }` to `PresenceScreen` (movement commands go straight to the session; Join/Leave keep going through the service).

- [ ] **Step 4: Run to verify it passes and the app builds**

Run: `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`
Expected: PASS, BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add android
git commit -m "feat(android): Follow / Walk to / Stop actions in the Compose lists

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Observability (logcat) and CLI tools

**Files:**
- Modify: `android/app/src/main/kotlin/app/workadventurer/app/WaApp.kt`, `android/wa-cli/src/main/kotlin/app/workadventurer/cli/Main.kt`, `android/wa-cli/build.gradle.kts` (no change expected: it already depends on `:protocol`, which exposes `:nav` via `api`)

**Interfaces:**
- Consumes: everything above. Produces: (a) logcat lines tagged `WaConn` (every `PusherConnection.log` line) and `WaSession` (each connection-state change), so a soak can answer "did a silent reconnect happen?" (the open G1 question); passing `cacheDir = File(cacheDir, "nav")` to each connection; (b) `wa-cli collision --baked <collision.json>` which rebuilds the grid **from the live `.wam` + `.tmj` named in that baked file's `source`** and prints whether the blocked-tile sets are identical (parity with the Node bake); (c) `wa-cli --name X [--follow NAME | --walk-to-area NAME] [--seconds N]` so movement can be live-checked from the Mac before the phone.

These are platform/CLI glue with no unit tests: they are proven by the live checks in Task 11.

- [ ] **Step 1: `WaApp` logging and cache dir**

```kotlin
class WaApp : Application() {
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val session: WaSession by lazy {
        val s = WaSession(
            scope = appScope,
            factory = { cfg ->
                PusherConnection(http, cfg, cacheDir = File(cacheDir, "nav")).also { c ->
                    val logJob = appScope.launch { c.log.collect { Log.i("WaConn", it) } }
                    c.closed.invokeOnCompletion { logJob.cancel() }
                }
            },
        )
        appScope.launch {
            s.state.map { it.connection }.distinctUntilChanged().collect { Log.i("WaSession", it.toString()) }
        }
        s
    }
}
```

(imports: `android.util.Log`, `java.io.File`, `kotlinx.coroutines.flow.distinctUntilChanged`, `kotlinx.coroutines.flow.map`, `kotlinx.coroutines.launch`.)

- [ ] **Step 2: CLI**

Replace `Main.kt` so `args[0] == "collision"` runs the parity check and otherwise the existing join flow gains `--follow` / `--walk-to-area`:

```kotlin
package app.workadventurer.cli

import app.workadventurer.nav.CollisionBuilder
import app.workadventurer.nav.NavGrid
import app.workadventurer.nav.Navigator
import app.workadventurer.nav.Pt
import app.workadventurer.nav.Target
import app.workadventurer.nav.snapToFree
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import app.workadventurer.protocol.Wa133
import app.workadventurer.protocol.toFacing
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import kotlin.system.exitProcess

private fun opt(args: Array<String>, flag: String) = args.indexOf(flag).takeIf { it >= 0 }?.let { args.getOrNull(it + 1) }

private fun fetch(http: OkHttpClient, url: String): String =
    http.newCall(Request.Builder().url(url).build()).execute().use { check(it.isSuccessful) { "HTTP ${it.code} for $url" }; it.body!!.string() }

/** Rebuilds a grid from the live .wam/.tmj named in a baked collision.json and compares blocked-tile sets. */
private fun collisionParity(args: Array<String>): Nothing {
    val bakedPath = opt(args, "--baked") ?: run { System.err.println("usage: collision --baked <collision.json>"); exitProcess(2) }
    val baked = File(bakedPath).readText()
    val source = Json.parseToJsonElement(baked).jsonObject.getValue("source").jsonObject
    val http = OkHttpClient()
    val grid = CollisionBuilder.build(fetch(http, source.getValue("wam").jsonPrimitive.content), fetch(http, source.getValue("map").jsonPrimitive.content))
    if (grid == null) { System.err.println("could not build a grid from ${source}"); exitProcess(1) }
    val bakedGrid = NavGrid.fromBakedJson(baked)
    val a = grid.blockedIndices().toSet()
    val b = bakedGrid.blockedIndices().toSet()
    println("kotlin: ${grid.w}x${grid.h} tile ${grid.tile}, ${a.size} blocked | baked: ${bakedGrid.w}x${bakedGrid.h} tile ${bakedGrid.tile}, ${b.size} blocked")
    println("only in kotlin: ${(a - b).sorted().take(30)} | only in baked: ${(b - a).sorted().take(30)}")
    val same = grid.w == bakedGrid.w && grid.h == bakedGrid.h && a == b
    println(if (same) "PARITY: identical" else "PARITY: DIFFERENT (the map may have changed since it was baked; see the lists above)")
    exitProcess(if (same) 0 else 1)
}

fun main(args: Array<String>): Unit = runBlocking<Unit> {
    if (args.firstOrNull() == "collision") collisionParity(args)
    val name = opt(args, "--name") ?: run {
        System.err.println("usage: --name <avatar> [--room URL] [--pusher URL] [--api-version H] [--seconds N] [--follow NAME | --walk-to-area NAME]\n       collision --baked <collision.json>\n(name the avatar after your worktree, never bare 'claude')")
        exitProcess(2)
    }
    val cfg = RoomConfig(
        name = name,
        roomUrl = opt(args, "--room") ?: Wa133.DEFAULT_ROOM,
        pusherUrl = opt(args, "--pusher") ?: Wa133.DEFAULT_PUSHER,
        apiVersionHash = opt(args, "--api-version") ?: Wa133.API_VERSION_HASHES[0],
    )
    val seconds = opt(args, "--seconds")?.toInt() ?: 30
    val conn = PusherConnection(OkHttpClient(), cfg, cacheDir = File(System.getProperty("java.io.tmpdir"), "wa-cli-nav"))
    val logJob = launch { conn.log.collect { println("· $it") } }
    try { conn.connect() } catch (e: Exception) { System.err.println("join failed: ${e.message}"); exitProcess(1) }

    val nav = Navigator({ conn.grid.value }, conn, System::currentTimeMillis)
    fun find(needle: String) = conn.state.players.value.values.firstOrNull { it.name.contains(needle, ignoreCase = true) }
    val moveJob = when {
        opt(args, "--follow") != null -> {
            val needle = opt(args, "--follow")!!
            launch {
                withTimeoutOrNull(15_000) { while (find(needle) == null) delay(200) } ?: run { println("no player matching '$needle'"); return@launch }
                println("· following ${find(needle)!!.name}")
                val id = find(needle)!!.userId
                println("· follow ended: ${nav.follow({ conn.state.players.value[id]?.let { Target(it.x.toDouble(), it.y.toDouble(), it.direction.toFacing()) } })}")
            }
        }
        opt(args, "--walk-to-area") != null -> {
            val needle = opt(args, "--walk-to-area")!!
            launch {
                withTimeoutOrNull(15_000) { while (conn.grid.value == null) delay(200) } ?: println("· no nav grid; walking straight")
                val a = conn.state.areas.firstOrNull { it.name.contains(needle, ignoreCase = true) } ?: run { println("no area matching '$needle'"); return@launch }
                val c = Pt(a.x + a.w / 2.0, a.y + a.h / 2.0)
                println("· walking to ${a.name}")
                println("· walk ended: ${nav.navTo(conn.grid.value?.snapToFree(c.x, c.y) ?: c, stopWithin = 24.0)}")
            }
        }
        else -> null
    }

    repeat(seconds / 5) {
        delay(5_000)
        val players = conn.state.players.value.values.sortedBy { it.name.lowercase() }
        val areas = conn.state.currentAreas().joinToString { it.name }
        val p = conn.position()
        println("— ${players.size} players; me @ ${p.x.toInt()},${p.y.toInt()}; in areas: ${areas.ifEmpty { "(none)" }}; grid: ${conn.grid.value?.let { "${it.w}x${it.h}" } ?: "none"}")
        if (conn.closed.isCompleted) { println("closed: ${conn.closed.await()}"); exitProcess(1) }
    }
    moveJob?.cancel()
    conn.close()
    logJob.cancel()
    exitProcess(0)
}
```

- [ ] **Step 3: Build everything**

Run: `cd android && ./gradlew test :wa-cli:installDist :app:assembleDebug`
Expected: all tests pass; BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add android
git commit -m "feat(android): logcat observability, wa-cli follow/walk-to-area and collision parity

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: G2 live checks and findings

**Files:**
- Modify: `android/docs/field-notes.md` (G2 section), `docs/superpowers/specs/2026-10-05-android-client-design.md` only if a finding contradicts it.

**Interfaces:** consumes the built CLI and APK; produces the findings write-up and a go/no-go for G3.

Everything below is a **live** check (the spec's rule). Avatar names are worktree-derived (`android-g2-nav`, `android-g2-nav-phone`), never bare `claude`.

- [ ] **Step 1: Collision parity against the three baked maps (no human needed)**

Use a helper like `scratchpad/wacli.sh`, but for the `collision` subcommand, from the **repo root** so the `map/` paths resolve:

```bash
for f in map/afrolabs/afrolabs/open-space map/levelup-npc/lean-iterator/campus map/tcm/workadventure/wa-village; do
  <wa-cli> collision --baked $f/collision.json
done
```

Expected: `PARITY: identical` for each. Any difference is a **finding, not a failure to hide**: print the offending indices, decide whether it is a builder bug (fix with a test that reproduces it) or the map having changed since it was baked (check the baked file's date vs `git log`; re-bake with `node scripts/build-collision.mjs <roomUrl>` and compare). Record the outcome per map in the field notes. The Node script only ever baked these three maps; a clean result on all three is strong evidence the runtime builder matches the bake.

- [ ] **Step 2: Mac-side movement against a real browser avatar**

Ask the user to have a browser avatar in afrolabs and tell you its display name. Then run, in turn:

```
<wa-cli> --name android-g2-nav --seconds 90 --follow <their name>
<wa-cli> --name android-g2-nav --seconds 60 --walk-to-area "<an area name from the area list>"
```

Ask the user to (a) walk their avatar around, **through a doorway and around furniture**, and watch `android-g2-nav` follow without walking through walls; (b) confirm it stands in front of / behind them sensibly; (c) confirm no avatar stutter between waypoints (the Node client's per-waypoint stop). The CLI prints `grid: 100x74` once the grid has loaded: if it stays `none`, that is a finding (the `.tmj` download, the user-agent, or the builder).

- [ ] **Step 3: The phone**

Install the debug APK (`adb -s <serial> install -r …`; the S25 Ultra is `R5CY31ENYEH` over USB). Ask the user to: join with a name like `android-g2-nav-phone`; tap **Follow** on their browser avatar and walk it around (including through a doorway); tap **Walk to** on an area and on a player; tap **Stop**; lock the screen for a few minutes **while following**; then unlock. Expected: the browser shows the phone avatar following and routing around walls; the list's "(you are here)" updates; Stop stops it. Record what the user saw as *reported*, and what `adb logcat -s WaConn:I WaSession:I` shows as *measured* (grid ready time, any `Reconnecting`).

- [ ] **Step 4: The G1 items still owed (same phone session)**

Verify and record, each as measured or reported: (a) after **Leave** no stale notification remains (`adb shell dumpsys notification --noredact | grep app.workadventurer` shows nothing); (b) joining a bogus room URL ends in `Couldn't join…` **and the foreground service stops** (no ongoing notification); (c) deny the microphone permission on first run and confirm the on-screen message instead of a crash; (d) the new logcat output: any `Reconnecting` during the soak, with its cause.

- [ ] **Step 5: Write the findings and decide**

Append a `## G2` section to `android/docs/field-notes.md`: parity results per map; grid load time on the phone (first run vs cached); what the user saw; every surprise; the verdict on the architecture going into G3 (`:voice`). If something contradicts the spec, update the spec first.

- [ ] **Step 6: Commit and report**

```bash
git add android docs
git commit -m "docs(android): G2 live-check findings

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Post a short G2 results comment on issue #54 (measured vs reported, kept separate), then stop. G3 (voice, the riskiest gate) gets its own plan.

---

## Self-Review

- **Spec coverage:** G2 asks for a `:nav` port, follow and walk-to, and a live check that the phone avatar follows a browser avatar across the map. Tasks 0-4 are the `:nav` port (grid, A\* with exact Node parity, steering, runtime builder, navigator); Tasks 5-8 wire it into the pose, connection and session; Task 9 is the UI to drive it; Task 11 is the live check. The user's collision-source decision is Tasks 3 and 6. Deliberately not here: enclosed-room logic, joining Spaces on area entry (G3), joystick/map rendering.
- **Placeholder scan:** every step carries its code or exact command. Two places describe edits by position rather than showing the whole file (Task 7's `PusherConnection` changes and Task 9's `PresenceScreen` row replacement); both show the exact new code for every changed member and name the lines they replace.
- **Type consistency:** `Facing`, `Pt` (Task 0) → `Target`, `faceToward`, `followPoint`, `frontOf`, `snapToFree` (Tasks 2, 5) → `MovementSink`, `Outcome`, `Navigator(grid: () -> NavGrid?, sink, nowMs)` (Task 4) → `Pose`, `toDirection/toFacing` (Task 5) → `fetchWamJson`, `loadNavGrid(http, wamJson, cacheDir, nowMs, ttlMs)` (Task 6) → `PusherConnection : MovementSink`, `grid`, `cacheDir` (Task 7) → `Command.*`, `Activity`, `SessionState.activity` (Task 8) → `activityText`, `onCommand` (Task 9). `gridOf` is defined once (Task 0's test file) and reused by later `:nav` tests in the same package.
- **Known risks, each a learning rather than a blocker:** exact A\* parity with Node (heap tie-breaks); the 1.5 MB `.tmj` download on a phone (first-run delay is hidden by the background load, and measured in Task 11); `map-storage`/S3 user-agent and CDN behaviour (the Node/OkHttp agents work, Python's did not); runtime builder drift from the Node bake (Task 11 Step 1 measures it); Samsung/One UI idle behaviour while following with the screen locked (Task 11 Step 3).
