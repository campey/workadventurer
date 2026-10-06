package app.workadventurer.app.session

/**
 * When the presence service stops, should it also reset the session? Not after a failed join: the service stops
 * itself then, and resetting wiped "Couldn't join: …" within milliseconds (seen on a real phone). The reason stays
 * until the next Join or an explicit Leave.
 */
fun shouldLeaveWhenServiceStops(state: SessionState): Boolean = state.connection !is Connection.Failed
