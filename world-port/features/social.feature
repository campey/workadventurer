Feature: Chat, bubbles and emotes
  Whether speech and thought bubbles actually RENDER above the avatar is a manual
  check (look at the avatar in a browser): no event reaches another client for it.
  The scenarios here only prove the server accepts the messages and keeps us connected.

  Background:
    Given the world "afrolabs open space"
    And avatar A is in the world
    And avatar B is in the world
    And avatar B is 400 px away from avatar A
    When avatar A walks next to avatar B
    Then avatars A and B are in the same meeting

  # source: docs/field-notes.md "Chat: one wire mechanism (Space chat)..."; live run NOT YET RUN
  Scenario: A chat message in a shared meeting reaches the other avatar
    When avatar A says "hello from the probe" in the meeting
    Then avatar B receives the chat message "hello from the probe" from avatar A

  # source: no probe or field-notes section yet (selfcheck covers the send); live run NOT YET RUN
  Scenario: Bubbles can be set and cleared without losing the connection
    When avatar A sets and clears a speech bubble and a thought bubble
    And 5 seconds pass
    Then avatar A is still connected
    When avatar A walks 100 px east
    Then avatar B sees avatar A move

  # source: no probe or field-notes section yet; live run NOT YET RUN
  Scenario: An emote reaches the other avatar
    When avatar A emotes "👋"
    Then avatar B sees avatar A emote "👋"
