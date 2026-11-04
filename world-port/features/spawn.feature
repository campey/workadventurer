Feature: Spawn

  # source: probe spawn, 2026-10-10 (afrolabs confirms); live run 2026-10-10 passed (afrolabs)
  # the academy has no .wam start area (probe spawn 2026-10-10): it spawns on the Tiled start layer,
  # so its row skips (no confirmed start area); do not invent one.
  @needs-start-area
  Scenario Outline: I appear in the world's start area
    Given the world "<world>"
    And avatar B is in the world
    When avatar A connects
    Then avatar B sees avatar A inside the start area

    Examples:
      | world               |
      | afrolabs open space |
      | the academy         |
