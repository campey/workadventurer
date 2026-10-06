package app.workadventurer.protocol

/** The server answered a query with an error. */
class QueryFailed(message: String) : Exception(message)
