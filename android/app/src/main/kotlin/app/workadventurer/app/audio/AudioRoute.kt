package app.workadventurer.app.audio

enum class DeviceKind { Earpiece, Speaker, Wired, Usb, Bluetooth }

/** One thing to talk and listen with: its speaker and its microphone together. [id] is Android's device id; [name] is for the screen only (never the log). */
data class AudioDevice(val id: Int, val kind: DeviceKind, val name: String) {
    val isHeadset get() = kind == DeviceKind.Wired || kind == DeviceKind.Usb || kind == DeviceKind.Bluetooth
}

/**
 * Which device a call uses (issue #164). Speaker unless something better is connected: a headset (wired, USB, Bluetooth)
 * is switched to as soon as it appears, the newest one if there are several, and when it goes the phone device you last chose
 * comes back. A device you pick yourself stays until it goes or another headset arrives. Pure, so the policy is tested; the
 * platform side (AudioRouter) only reports the devices and applies [active].
 */
data class AudioRoute(
    private val known: List<AudioDevice> = emptyList(), // oldest first, so the newest headset is the last
    private val pinned: Int? = null,
    private val phoneChoice: DeviceKind = DeviceKind.Speaker,
) {
    /** Every device in the order the button steps through them: headsets (oldest first), then the speaker, then the earpiece. */
    val devices: List<AudioDevice> get() =
        known.filter { it.isHeadset } +
            listOfNotNull(known.firstOrNull { it.kind == DeviceKind.Speaker }, known.firstOrNull { it.kind == DeviceKind.Earpiece })

    val active: AudioDevice? get() =
        known.firstOrNull { it.id == pinned }
            ?: known.lastOrNull { it.isHeadset }
            ?: known.firstOrNull { it.kind == phoneChoice }
            ?: known.firstOrNull { it.kind == DeviceKind.Speaker }
            ?: known.firstOrNull { it.kind == DeviceKind.Earpiece }

    /** The devices Android reports now. A headset we have not seen before takes over, even from a device you picked. */
    fun devicesChanged(now: List<AudioDevice>): AudioRoute {
        val nowIds = now.map { it.id }.toSet()
        val before = known.map { it.id }.toSet()
        val kept = known.filter { it.id in nowIds }.map { old -> now.first { it.id == old.id } }
        val fresh = now.filter { it.id !in before }
        val headsetArrived = fresh.any { it.isHeadset }
        return copy(
            known = kept + fresh,
            pinned = if (headsetArrived || pinned !in nowIds) null else pinned,
        )
    }

    /** You chose [device]. Nothing happens if it is not there any more. */
    fun pick(device: AudioDevice): AudioRoute {
        if (known.none { it.id == device.id }) return this
        val phone = if (device.kind == DeviceKind.Speaker || device.kind == DeviceKind.Earpiece) device.kind else phoneChoice
        return copy(pinned = device.id, phoneChoice = phone)
    }
}

/** The microphone line on the audio sheet: the microphone is the one on the device in use. */
fun micDeviceName(device: AudioDevice?): String = when {
    device == null -> "No microphone"
    device.isHeadset -> "${device.name} microphone"
    else -> "Phone microphone"
}

fun audioButtonDescription(device: AudioDevice?) = "Audio device: ${device?.name ?: "none"}. Opens audio options"
