Feature: Presence and proximity
  Background:
    Given the world "afrolabs open space"

  # source: docs/field-notes.md "Two (or more) headless daemons can talk to each other"; live run 2026-10-10 passed
  Scenario: A player's arrival, movement and departure are seen
    Given avatar A is in the world
    When avatar B connects
    Then avatar A sees avatar B arrive
    When avatar B walks 100 px east
    Then avatar A sees avatar B move
    When avatar B leaves
    Then avatar A sees avatar B leave

  # source: port contract (fake-only: avatars are matched by name, never by shared state)
  @fake
  Scenario: Strangers are not mistaken for our avatars
    Given avatar A is in the world
    And a stranger named "Someone" arrives and moves
    Then avatar A has been told "Someone" arrived
    And avatar A has not been told avatar B arrived
    When avatar B connects
    Then avatar A sees avatar B arrive
    Given the stranger leaves
    When avatar B walks 100 px east
    Then avatar A sees avatar B move

  # source: docs/field-notes.md "Two (or more) headless daemons can talk to each other"; live run 2026-10-10 passed
  Scenario: Walking next to another avatar puts both in the same meeting
    Given avatar A is in the world
    And avatar B is in the world
    And avatar B is 400 px away from avatar A
    When avatar A walks next to avatar B
    Then avatars A and B are in the same meeting
