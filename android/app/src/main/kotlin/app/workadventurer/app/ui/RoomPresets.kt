package app.workadventurer.app.ui

import app.workadventurer.protocol.Wa133

/** A room worth one tap on the join screen. History and deep links are the fuller version (issue #93). */
data class RoomPreset(val name: String, val url: String)

/** First is the default a fresh install joins. Staging needs its own server settings first (issue #93). */
val ROOM_PRESETS = listOf(
    RoomPreset("Afrolabs open space", Wa133.DEFAULT_ROOM),
    RoomPreset("Lean Iterator campus", "https://play.workadventu.re/@/levelup-npc/lean-iterator/campus"),
)

/** The preset whose link is in the field (ignoring surrounding spaces), if any. */
fun presetNameFor(typed: String): String? = ROOM_PRESETS.firstOrNull { it.url == typed.trim() }?.name
