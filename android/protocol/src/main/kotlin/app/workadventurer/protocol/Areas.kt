package app.workadventurer.protocol

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
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
    /** Set when the area has a `livekitRoomProperty`: being in it means being in that meeting. */
    val meetingRoom: MeetingRoom? = null,
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
            meetingRoom = props.firstOrNull { it["type"]?.jsonPrimitive?.contentOrNull == "livekitRoomProperty" }?.let {
                MeetingRoom(it["id"]?.jsonPrimitive?.contentOrNull, it["roomName"]?.jsonPrimitive?.contentOrNull)
            },
        )
    }
}

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

/** Best-effort: any failure yields an empty list (join must still work without areas). */
suspend fun loadAreas(http: OkHttpClient, cfg: RoomConfig): List<Area> =
    fetchWamJson(http, cfg)?.let { try { parseWam(it) } catch (e: Exception) { emptyList() } } ?: emptyList()

fun pickSpawn(areas: List<Area>, rnd: Random = Random.Default): Spawn {
    val starts = areas.filter { it.isStart }
    val a = starts.firstOrNull { it.isDefaultStart } ?: starts.firstOrNull()
        ?: return Spawn(320, 320, null)
    val x = a.x + SPAWN_MARGIN + rnd.nextInt(maxOf(1, a.w - 2 * SPAWN_MARGIN))
    val y = a.y + SPAWN_MARGIN + rnd.nextInt(maxOf(1, a.h - 2 * SPAWN_MARGIN))
    return Spawn(x, y, a.name)
}
