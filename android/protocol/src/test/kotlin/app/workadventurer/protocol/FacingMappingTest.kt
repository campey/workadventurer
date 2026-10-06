package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.proto.PositionMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class FacingMappingTest {
    @Test
    fun everyFacingRoundTripsThroughTheWireEnum() {
        for (f in Facing.entries) assertEquals(f, f.toDirection().toFacing())
        assertEquals(PositionMessage.Direction.LEFT, Facing.LEFT.toDirection())
        assertEquals(Facing.DOWN, PositionMessage.Direction.DOWN.toFacing())
    }
}
