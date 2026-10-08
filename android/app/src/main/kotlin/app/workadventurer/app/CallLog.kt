package app.workadventurer.app

import app.workadventurer.app.session.Connection

/**
 * The app's one place to log. Every line still goes to logcat ([logcat]); while a call is open it also goes to that call's
 * file ([files]). Calls open and close from the connection state: [Connection.Connecting] starts one (only a Join sets it),
 * a drop and reconnect stays in the same file, [Connection.Disconnected] (Leave) or [Connection.Failed] ends it.
 */
class CallLog(
    private val files: CallLogFiles,
    private val logcat: (tag: String, message: String) -> Unit,
    /** The first lines of each file: app, phone, room, server. */
    private val header: (roomUrl: String) -> List<String>,
    private val logcatError: (tag: String, message: String) -> Unit = logcat,
) {
    fun i(tag: String, message: String) {
        logcat(tag, message)
        files.append(tag, message)
    }

    /** An error: red in logcat, and marked `ERROR` in the file so it stands out when scanning a long call. */
    fun e(tag: String, message: String) {
        logcatError(tag, message)
        files.append(tag, "ERROR $message")
    }

    fun onConnection(connection: Connection, roomUrl: String) {
        when (connection) {
            Connection.Connecting -> { files.start(roomUrl, header(roomUrl)); i(TAG, "connecting") }
            Connection.Connected -> i(TAG, "connected")
            is Connection.Reconnecting -> i(TAG, "reconnecting (attempt ${connection.attempt}, in ${connection.inMs} ms)")
            is Connection.Failed -> { i(TAG, "failed: ${connection.message}"); files.end() }
            Connection.Disconnected -> {
                if (files.isOpen) { i(TAG, "disconnected"); files.end() } else logcat(TAG, "disconnected")
            }
        }
    }

    private companion object { const val TAG = "WaSession" }
}
