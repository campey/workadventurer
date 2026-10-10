Feature: Spawn

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
