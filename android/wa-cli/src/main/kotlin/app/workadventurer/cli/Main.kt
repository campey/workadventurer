package app.workadventurer.cli

import app.workadventurer.nav.CollisionBuilder
import app.workadventurer.nav.NavGrid
import app.workadventurer.nav.Navigator
import app.workadventurer.nav.Pt
import app.workadventurer.nav.snapToFree
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import app.workadventurer.protocol.Wa133
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
    http.newCall(Request.Builder().url(url).build()).execute().use {
        check(it.isSuccessful) { "HTTP ${it.code} for $url" }
        it.body!!.string()
    }

/** Rebuilds a grid from the live .wam/.tmj named in a baked collision.json and compares blocked-tile sets. */
private fun collisionParity(args: Array<String>): Nothing {
    val bakedPath = opt(args, "--baked") ?: run {
        System.err.println("usage: collision --baked <collision.json>")
        exitProcess(2)
    }
    val baked = File(bakedPath).readText()
    val source = Json.parseToJsonElement(baked).jsonObject.getValue("source").jsonObject
    val http = OkHttpClient()
    val grid = CollisionBuilder.build(
        fetch(http, source.getValue("wam").jsonPrimitive.content),
        fetch(http, source.getValue("map").jsonPrimitive.content),
    )
    if (grid == null) {
        System.err.println("could not build a grid from $source")
        exitProcess(1)
    }
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
        System.err.println(
            "usage: --name <avatar> [--room URL] [--pusher URL] [--api-version H] [--seconds N] [--walk-to-area NAME]\n" +
                "       collision --baked <collision.json>\n(name the avatar after your worktree, never bare 'claude')",
        )
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
    try {
        conn.connect()
    } catch (e: Exception) {
        System.err.println("join failed: ${e.message}")
        exitProcess(1)
    }

    val nav = Navigator({ conn.grid.value }, conn, System::currentTimeMillis)
    val moveJob = when {
        opt(args, "--walk-to-area") != null -> {
            val needle = opt(args, "--walk-to-area")!!
            launch {
                withTimeoutOrNull(15_000) { while (conn.grid.value == null) delay(200) }
                    ?: println("· no nav grid; walking straight")
                val a = conn.state.areas.firstOrNull { it.name.contains(needle, ignoreCase = true) }
                    ?: run { println("no area matching '$needle'"); return@launch }
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
        println(
            "— ${players.size} players; me @ ${p.x.toInt()},${p.y.toInt()}; in areas: ${areas.ifEmpty { "(none)" }}; " +
                "grid: ${conn.grid.value?.let { "${it.w}x${it.h}" } ?: "none"}",
        )
        if (conn.closed.isCompleted) {
            println("closed: ${conn.closed.await()}")
            exitProcess(1)
        }
    }
    moveJob?.cancel()
    conn.close()
    logJob.cancel()
    exitProcess(0)
}
