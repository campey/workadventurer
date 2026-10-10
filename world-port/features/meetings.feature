Feature: Area meetings

  # source: docs/field-notes.md "Map areas: dwell debounce"; live run NOT YET RUN
  @needs-meeting-area
  Scenario Outline: Walking into a meeting area joins its meeting
    Given the world "<world>"
    And avatar A is in the world
    When avatar A walks into the meeting area "<area>"
    Then avatar A joins the meeting for "<area>"

    Examples:
      | world               | area |
      | afrolabs open space | TBD  |
      | the academy         | TBD  |
