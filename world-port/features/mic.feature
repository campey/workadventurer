Feature: Microphone state of others

  Background:
    Given the world "afrolabs open space"
    And avatar A is in the world
    And avatar B is in the world
    And avatar B is 400 px away from avatar A
    When avatar A walks next to avatar B
    Then avatars A and B are in the same meeting

  # source: docs/field-notes.md "`#10` — the red mic, mic-state propagation"; live run 2026-10-10 passed
  Scenario: A peer's microphone state is seen by the other avatar in the meeting
    When avatar A turns the microphone on
    Then avatar B sees avatar A's microphone on
    When avatar A turns the microphone off
    Then avatar B sees avatar A's microphone off
