package app.workadventurer.app.audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AudioRouteTest {
    private val speaker = AudioDevice(1, DeviceKind.Speaker, "Phone speaker")
    private val earpiece = AudioDevice(2, DeviceKind.Earpiece, "Phone earpiece")
    private val wired = AudioDevice(3, DeviceKind.Wired, "Wired headset")
    private val buds = AudioDevice(4, DeviceKind.Bluetooth, "Andy's earbuds")
    private val usb = AudioDevice(5, DeviceKind.Usb, "USB headset")

    private fun route(vararg devices: AudioDevice) = AudioRoute().devicesChanged(devices.toList())

    @Test
    fun withNothingPluggedInTheSpeakerIsTheDefault() {
        assertEquals(speaker, route(earpiece, speaker).active)
    }

    @Test
    fun aPhoneWithNoEarpieceStillHasASpeaker_andNothingAtAllIsNull() {
        assertEquals(speaker, route(speaker).active)
        assertNull(route().active)
    }

    @Test
    fun aHeadsetThatConnectsIsSwitchedToAtOnce() {
        val r = route(speaker, earpiece).devicesChanged(listOf(speaker, earpiece, buds))
        assertEquals(buds, r.active)
    }

    @Test
    fun aHeadsetAlreadyConnectedWhenTheCallStartsIsUsed() {
        assertEquals(wired, route(speaker, earpiece, wired).active)
    }

    @Test
    fun whenAHeadsetGoesTheLastPhoneChoiceComesBack() {
        val r = route(speaker, earpiece, buds).devicesChanged(listOf(speaker, earpiece))
        assertEquals(speaker, r.active)
        val onEarpiece = route(speaker, earpiece).pick(earpiece).devicesChanged(listOf(speaker, earpiece, buds)).devicesChanged(listOf(speaker, earpiece))
        assertEquals(earpiece, onEarpiece.active) // you had chosen the earpiece before the headset came
    }

    @Test
    fun theNewestHeadsetWinsWhenSeveralAreConnected() {
        assertEquals(buds, route(speaker, wired, buds).active)
        assertEquals(wired, route(speaker, buds, wired).active)
    }

    @Test
    fun pickingADeviceKeepsItUntilItGoesOrAnotherHeadsetArrives() {
        val start = route(speaker, earpiece, buds)
        val onSpeaker = start.pick(speaker)
        assertEquals(speaker, onSpeaker.active) // you chose the speaker even though earbuds are connected
        assertEquals(speaker, onSpeaker.devicesChanged(listOf(speaker, earpiece, buds)).active) // a repeated device list changes nothing
        assertEquals(usb, onSpeaker.devicesChanged(listOf(speaker, earpiece, buds, usb)).active) // a new headset takes over again
        assertEquals(speaker, onSpeaker.devicesChanged(listOf(speaker, earpiece)).active) // the earbuds leaving does not move you
    }

    @Test
    fun aPickedDeviceThatDisappearsFallsBackToThePolicy() {
        val r = route(speaker, earpiece, wired).pick(wired).devicesChanged(listOf(speaker, earpiece))
        assertEquals(speaker, r.active)
    }

    @Test
    fun pickingSomethingThatIsNotThereChangesNothing() {
        val r = route(speaker, earpiece)
        assertEquals(r, r.pick(buds))
    }

    @Test
    fun theButtonStepsThroughTheDevicesAndWrapsRound() {
        val r = route(speaker, earpiece)
        assertEquals(earpiece, r.next().active) // speaker -> earpiece
        assertEquals(speaker, r.next().next().active) // and back
        val withBuds = route(speaker, earpiece, buds)
        assertEquals(listOf(buds, speaker, earpiece), withBuds.devices) // headsets first, then the phone's own
        assertEquals(speaker, withBuds.next().active) // buds -> speaker
        assertEquals(earpiece, withBuds.next().next().active)
        assertEquals(buds, withBuds.next().next().next().active)
    }

    @Test
    fun theMicrophoneIsNamedAfterTheDeviceInUse() {
        assertEquals("Phone microphone", micDeviceName(speaker))
        assertEquals("Phone microphone", micDeviceName(earpiece))
        assertEquals("Andy's earbuds microphone", micDeviceName(buds))
        assertEquals("Wired headset microphone", micDeviceName(wired))
        assertEquals("No microphone", micDeviceName(null))
    }

    @Test
    fun theButtonSaysWhichDeviceIsInUse() {
        assertEquals("Audio device: Phone speaker. Opens audio options", audioButtonDescription(speaker))
        assertEquals("Audio device: Andy's earbuds. Opens audio options", audioButtonDescription(buds))
        assertEquals("Audio device: none. Opens audio options", audioButtonDescription(null))
    }
}
