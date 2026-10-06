package app.workadventurer.protocol

/** The server answered a query with an error. */
class QueryFailed(message: String) : Exception(message)

/** What the wa-1.33/1.34 adapter asks to sync when the server doesn't say. */
val DEFAULT_SPACE_PROPS = listOf("cameraState", "microphoneState", "screenSharingState")
