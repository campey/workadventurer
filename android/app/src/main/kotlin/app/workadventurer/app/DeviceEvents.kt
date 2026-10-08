package app.workadventurer.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * While a call is open, writes what the phone itself does around it to the call log (tag `WaDevice`): audio devices coming and
 * going, the screen turning off and on, the network changing, and which permissions we hold. These are the things that explain
 * a quirk afterwards ("it went quiet when I plugged in the headset", "it dropped when the phone left wifi").
 * Types and states only, never device names (a Bluetooth name is often a person's name). Platform glue, verified on the phone.
 */
class DeviceEvents(private val context: Context, private val log: CallLog) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private var running = false
    private var lastNetwork = ""

    private val audioCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<AudioDeviceInfo>) = added.forEach { log.i(TAG, "audio device added: ${describe(it)}") }
        override fun onAudioDevicesRemoved(removed: Array<AudioDeviceInfo>) = removed.forEach { log.i(TAG, "audio device removed: ${describe(it)}") }
    }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> log.i(TAG, "screen off")
                Intent.ACTION_SCREEN_ON -> log.i(TAG, "screen on")
                Intent.ACTION_USER_PRESENT -> log.i(TAG, "phone unlocked")
            }
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            val now = transports(caps)
            val down = caps.linkDownstreamBandwidthKbps / 1000
            val summary = "$now ${if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) "validated" else "not validated"}"
            // Bandwidth estimates jitter; log only when the kind or validation changes, with the estimate as context.
            if (summary != lastNetwork) { lastNetwork = summary; log.i(TAG, "network: $summary (~$down Mbit/s down)") }
        }

        override fun onLost(network: Network) { lastNetwork = ""; log.i(TAG, "network lost") }
    }

    /** Safe to call twice. Registers listeners and writes a first snapshot (the audio callback replays the current devices). */
    @Synchronized
    fun start() {
        if (running) return
        running = true
        log.i(TAG, "permissions: microphone ${granted(Manifest.permission.RECORD_AUDIO)}, notifications ${notifications()}")
        runCatching { audio.registerAudioDeviceCallback(audioCallback, null) }.onFailure { log.e(TAG, "audio device callback: ${it.message}") }
        runCatching {
            val filter = IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT)
            }
            ContextCompat.registerReceiver(context, screenReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        }.onFailure { log.e(TAG, "screen receiver: ${it.message}") }
        runCatching { connectivity.registerDefaultNetworkCallback(networkCallback) }.onFailure { log.e(TAG, "network callback: ${it.message}") }
    }

    @Synchronized
    fun stop() {
        if (!running) return
        running = false
        lastNetwork = ""
        runCatching { audio.unregisterAudioDeviceCallback(audioCallback) }
        runCatching { context.unregisterReceiver(screenReceiver) }
        runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
    }

    private fun granted(permission: String) = if (ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED) "granted" else "DENIED"
    private fun notifications() = if (Build.VERSION.SDK_INT >= 33) granted(Manifest.permission.POST_NOTIFICATIONS) else "n/a"

    private fun transports(caps: NetworkCapabilities) = listOf(
        NetworkCapabilities.TRANSPORT_WIFI to "wifi", NetworkCapabilities.TRANSPORT_CELLULAR to "cellular",
        NetworkCapabilities.TRANSPORT_ETHERNET to "ethernet", NetworkCapabilities.TRANSPORT_VPN to "vpn",
        NetworkCapabilities.TRANSPORT_BLUETOOTH to "bluetooth",
    ).filter { caps.hasTransport(it.first) }.joinToString("+") { it.second }.ifEmpty { "other" }

    private fun describe(d: AudioDeviceInfo) = "${typeName(d.type)} (${if (d.isSource) "input" else "output"})"

    private fun typeName(type: Int) = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "built-in mic"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired headset"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired headphones"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "usb headset"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "usb device"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth (call)"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth (media)"
        AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth LE headset"
        AudioDeviceInfo.TYPE_HEARING_AID -> "hearing aid"
        AudioDeviceInfo.TYPE_TELEPHONY -> "telephony"
        AudioDeviceInfo.TYPE_REMOTE_SUBMIX -> "remote submix"
        else -> "type $type"
    }

    private companion object { const val TAG = "WaDevice" }
}
