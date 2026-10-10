Feature: Presence and proximity
  Background:
    Given the world "afrolabs open space"

  Scenario: A player's arrival, movement and departure are seen
    Given avatar A is in the world
    When avatar B connects
    Then avatar A sees avatar B arrive
    When avatar B walks 100 px east
    Then avatar A sees avatar B move
    When avatar B leaves
    Then avatar A sees avatar B leave

  @fake
  Scenario: Strangers are not mistaken for our avatars
    Given avatar A is in the world
    And a stranger named "Someone" arrives, moves and leaves
    Then avatar A does not see avatar B arrive
    When avatar B connects
    Then avatar A sees avatar B arrive

  Scenario: Walking next to another avatar puts both in the same meeting
    Given avatar A is in the world
    And avatar B is in the world
    And avatar B is 400 px away from avatar A
    When avatar A walks next to avatar B
    Then avatars A and B are in the same meeting
