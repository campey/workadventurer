// STT output into the room (#41): partials as a thought bubble over the avatar,
// finals as one `Name: text` line in Space chat. Chat is append-only (no edit),
// and name/avatar in chat are fixed per connection, so the speaker label is in
// the text. See docs/field-notes.md.

/**
 * @param {object} client  WorkAdventureClient (spaces, sendChatMessage, thoughtBubble, clearBubble, spaceUserName)
 * @returns {(e: {remoteUserId: string, text: string, final: boolean}) => void}
 */
export function makeSttRoomOutput(client) {
  return function onHeard({ remoteUserId, text, final }) {
    if (!text) return;
    const who = client.spaceUserName(remoteUserId) ?? String(remoteUserId).split("/").pop();
    const line = `${who}: ${text}`;
    if (!final) {
      client.thoughtBubble(line); // replaces the previous partial in place
      return;
    }
    client.clearBubble();
    for (const spaceName of client.spaces.keys()) client.sendChatMessage(spaceName, line);
  };
}
