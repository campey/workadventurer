package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.proto.PositionMessage

fun Facing.toDirection(): PositionMessage.Direction = when (this) {
    Facing.UP -> PositionMessage.Direction.UP
    Facing.RIGHT -> PositionMessage.Direction.RIGHT
    Facing.DOWN -> PositionMessage.Direction.DOWN
    Facing.LEFT -> PositionMessage.Direction.LEFT
}

fun PositionMessage.Direction.toFacing(): Facing = when (this) {
    PositionMessage.Direction.UP -> Facing.UP
    PositionMessage.Direction.RIGHT -> Facing.RIGHT
    PositionMessage.Direction.DOWN -> Facing.DOWN
    PositionMessage.Direction.LEFT -> Facing.LEFT
}
