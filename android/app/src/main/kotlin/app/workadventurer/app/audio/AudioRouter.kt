package app.workadventurer.app.audio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import app.workadventurer.app.CallLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Platform side of the audio route (issue #164): reports the devices Android has, keeps the [AudioRoute] policy up to date as they
 * come and go, and while a call is on makes the active device the communication device, so the speaker and the microphone move
 * together (a headset's own microphone with a headset, the phone's with the speaker or earpiece). Between calls it only tracks
 * the devices, so the bar and the sheet can show them. Glue over AudioManager: verified on the phone. The log gets device types
 * only, never names (a Bluetooth name is often a person's).
 */
class AudioRouter(context: Context, private val log: CallLog) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val _route = MutableStateFlow(AudioRoute())
    val route: StateFlow<AudioRoute> = _route.asStateFlow()
    private var inCall = false
    private var applied: Int? = null // the device id we last asked Android for; its own idea of the current device can disagree
    private var started = false

    private val callback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<AudioDeviceInfo>) = refresh()
        override fun onAudioDevicesRemoved(removedDevices: Array<AudioDeviceInfo>) = refresh()
    }

    /** Start tracking devices. Safe to call twice. */
    @Synchronized fun start() {
        if (started) return
        started = true
        runCatching { audio.registerAudioDeviceCallback(callback, null) }.onFailure { log.e(TAG, "audio device callback: ${it.message}") }
        refresh()
    }

    /** The call's audio mode is on: use the route's device. */
    @Synchronized fun callStarted() { inCall = true; apply() }

    /** The call is over: give the phone's audio back. */
    @Synchronized fun callEnded() {
        inCall = false
        applied = null
        runCatching {
            if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice() else audio.isSpeakerphoneOn = false
        }.onFailure { log.e(TAG, "clearing the audio device: ${it.message}") }
    }

    /** A device chosen from the sheet. */
    @Synchronized fun pick(device: AudioDevice) { _route.update { it.pick(device) }; apply() }

    @Synchronized private fun refresh() {
        val before = _route.value.active
        _route.update { it.devicesChanged(currentDevices().mapNotNull(::toDevice)) }
        if (_route.value.active != before) log.i(TAG, "audio device now ${_route.value.active?.kind?.name?.lowercase() ?: "none"}")
        apply()
    }

    private fun currentDevices(): List<AudioDeviceInfo> =
        if (Build.VERSION.SDK_INT >= 31) audio.availableCommunicationDevices
        else audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()

    private fun apply() {
        if (!inCall) return
        val active = _route.value.active ?: return
        runCatching {
            if (Build.VERSION.SDK_INT >= 31) {
                val info = audio.availableCommunicationDevices.firstOrNull { it.id == active.id } ?: return
                if (applied != info.id) {
                    val ok = audio.setCommunicationDevice(info)
                    log.i(TAG, "audio device set to ${active.kind.name.lowercase()}: ${if (ok) "ok" else "refused"}")
                    applied = if (ok) info.id else null
                }
            } else {
                // Before Android 12 there is only the speakerphone switch; a wired headset takes over by itself.
                audio.isSpeakerphoneOn = active.kind == DeviceKind.Speaker
            }
        }.onFailure { log.e(TAG, "setting the audio device: ${it.message}") }
    }

    private fun toDevice(info: AudioDeviceInfo): AudioDevice? {
        val name = info.productName?.toString().orEmpty()
        return when (info.type) {
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> AudioDevice(info.id, DeviceKind.Earpiece, "Phone earpiece")
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> AudioDevice(info.id, DeviceKind.Speaker, "Phone speaker")
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> AudioDevice(info.id, DeviceKind.Wired, name.ifBlank { "Wired headset" })
            AudioDeviceInfo.TYPE_USB_HEADSET -> AudioDevice(info.id, DeviceKind.Usb, name.ifBlank { "USB headset" })
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> AudioDevice(info.id, DeviceKind.Bluetooth, name.ifBlank { "Bluetooth headset" })
            else -> null // media-only outputs (Bluetooth A2DP, HDMI...) cannot carry a call
        }
    }

    private companion object { const val TAG = "WaDevice" }
}
