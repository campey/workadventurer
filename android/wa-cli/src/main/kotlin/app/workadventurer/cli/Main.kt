package app.workadventurer.cli

import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import app.workadventurer.protocol.Wa133
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import kotlin.system.exitProcess

fun main(args: Array<String>): Unit = runBlocking<Unit> {
    fun opt(flag: String) = args.indexOf(flag).takeIf { it >= 0 }?.let { args.getOrNull(it + 1) }
    val name = opt("--name") ?: run {
        System.err.println("usage: --name <avatar> [--room URL] [--pusher URL] [--seconds N]\n(name the avatar after your worktree, never bare 'claude')")
        exitProcess(2)
    }
    val cfg = RoomConfig(
        name = name,
        roomUrl = opt("--room") ?: Wa133.DEFAULT_ROOM,
        pusherUrl = opt("--pusher") ?: Wa133.DEFAULT_PUSHER,
        apiVersionHash = opt("--api-version") ?: Wa133.API_VERSION_HASHES[0],
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
