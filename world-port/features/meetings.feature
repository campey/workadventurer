Feature: Area meetings

  # source: docs/field-notes.md "Map areas: dwell debounce"; probe meeting-area, 2026-10-10 (confirms)
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
