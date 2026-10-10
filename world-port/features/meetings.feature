Feature: Area meetings

  # source: docs/field-notes.md "Map areas: dwell debounce"; probe meeting-area, 2026-10-10 (confirms); live run 2026-10-10 passed
  @needs-meeting-area
  Scenario Outline: Walking into a meeting area joins its meeting
    Given the world "<world>"
    And avatar A is in the world
    When avatar A walks into the meeting area "<area>"
    Then avatar A joins the meeting for "<area>"

    Examples:
      | world               | area |
      | afrolabs open space | Yellowish-Brownish Table |
      | the academy         | Lean Coffee Table 1 |

  # source: probes meeting-availability + firepit-meeting, 2026-10-10 (a browser sends LIVEKIT on entering a meeting area, ONLINE on leaving; with us doing the same a person saw one meeting and no proximity bubble)
  @needs-meeting-area
  Scenario Outline: A proximity pair walking into a meeting area leaves its bubble for the area meeting
    Given the world "<world>"
    And avatar A is in the world
    And avatar B is in the world
    And avatar B is 400 px away from avatar A
    When avatar A walks next to avatar B
    Then avatars A and B are in the same meeting
    When avatars A and B walk into the meeting area "<area>"
    Then avatars A and B join the meeting for "<area>"
    And avatars A and B have left the proximity meeting for the meeting for "<area>"

    Examples:
      | world               | area     |
      | afrolabs open space | Fire Pit |
