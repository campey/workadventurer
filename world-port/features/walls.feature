Feature: Walls

  # source: probe landmarks (NOT YET RUN)
  Scenario Outline: The world says what is solid
    Given the world "<world>"
    When avatar A connects
    Then the world says "<landmark>" is <state>

    Examples:
      | world | landmark | state |
      # rows land after a probe/campey confirms landmarks (see world-port/probes/README.md)
