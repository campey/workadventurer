package app.workadventurer.protocol

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

/** One picture the server offers: [id] is what a join sends as `characterTextureIds`, [url] is its spritesheet (always absolute). */
data class WokaTexture(val id: String, val name: String, val url: String)

data class WokaCollection(val name: String, val textures: List<WokaTexture>)

/**
 * What `GET {pusher}/woka/list?roomUrl=` returns: the parts (woka, body, eyes, hair, clothes, hat, accessory), each as collections
 * of textures. Catalogues differ per room and between prod and staging. The `woka` part is whole characters; the others are layers
 * to compose one from.
 */
data class WokaCatalogue(val parts: Map<String, List<WokaCollection>>) {
    /** The whole characters, collection by collection. */
    val wokas: List<WokaCollection> get() = parts["woka"].orEmpty()

    fun findWoka(id: String): WokaTexture? = wokas.firstNotNullOfOrNull { c -> c.textures.firstOrNull { it.id == id } }
}

/** Parses a `/woka/list` body. A picture address that isn't absolute is relative to the pusher, as the web client reads it. */
fun parseWokaCatalogue(body: String, pusherUrl: String): WokaCatalogue {
    val root = try {
        Json.parseToJsonElement(body).jsonObject
    } catch (e: Exception) {
        throw IOException("woka list was not understood: ${e.message}")
    }
    fun absolute(url: String) =
        if (url.startsWith("http://") || url.startsWith("https://")) url else pusherUrl.trimEnd('/') + "/" + url.trimStart('/')
    val parts = root.mapValues { (_, part) ->
        (part as? JsonObject)?.get("collections")?.jsonArray.orEmpty().map { c ->
            val collection = c.jsonObject
            WokaCollection(
                collection["name"]?.jsonPrimitive?.content.orEmpty(),
                collection["textures"]?.jsonArray.orEmpty().map { t ->
                    val texture = t.jsonObject
                    WokaTexture(
                        texture.getValue("id").jsonPrimitive.content,
                        texture["name"]?.jsonPrimitive?.content.orEmpty(),
                        absolute(texture.getValue("url").jsonPrimitive.content),
                    )
                },
            )
        }
    }
    return WokaCatalogue(parts)
}

/** The catalogue for [cfg]'s room, with the login token bare in `Authorization` (no "Bearer"). */
suspend fun fetchWokaCatalogue(http: OkHttpClient, cfg: RoomConfig, authToken: String): WokaCatalogue = withContext(Dispatchers.IO) {
    val url = (cfg.pusherUrl + "/woka/list").toHttpUrl().newBuilder().addQueryParameter("roomUrl", cfg.roomUrl).build()
    val req = Request.Builder().url(url).header("Authorization", authToken).build()
    http.newCall(req).execute().use { res ->
        val body = res.body?.string().orEmpty()
        if (!res.isSuccessful) throw IOException("woka list failed: ${res.code}")
        parseWokaCatalogue(body, cfg.pusherUrl)
    }
}
