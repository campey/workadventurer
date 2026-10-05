package app.workadventurer.protocol

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
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
        .addQueryParameter("version", cfg.apiVersionHash)
        .addQueryParameter("roomName", "")
        .addQueryParameter("cameraState", "false")
        .addQueryParameter("microphoneState", cfg.micOn.toString())
        .addQueryParameter("screenSharingState", "false")
        .addQueryParameter("chatID", "")
        .addQueryParameter("tabId", tabId)
        .build()
