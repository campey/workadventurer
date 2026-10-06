package app.workadventurer.protocol

/** Someone invited us over ("invite to discussion" in the web client). */
data class Invite(
    val senderUuid: String,
    val senderName: String,
    /** The sender's room user id if the server said it; they may not be visible to us, so this can be null. */
    val senderUserId: Int?,
    /** The sender's room, as the server reports it (used to locate them when they're outside our viewport). */
    val playUri: String,
)

/** What happened to an invite *we* sent. */
sealed interface InviteOutcome {
    data class Accepted(val name: String) : InviteOutcome
    data class Declined(val name: String) : InviteOutcome

    /** The server refused because we're sending too many invitations. */
    data object TooMany : InviteOutcome
}
