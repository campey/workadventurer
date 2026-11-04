Feature: Walls

  # source: wall walk 2026-10-10 — wa-probe-walls walked to each point and campey confirmed in a browser (👍);
  #         afrolabs rows live-verified. The academy's rows land after the same walk there.
  Scenario Outline: The world says what is solid
    Given the world "<world>"
    When avatar A connects
    Then the world says "<landmark>" is <state>

    Examples:
      | world | landmark | state |
      | afrolabs open space | obstacle south-west of the spawn | solid |
      | afrolabs open space | obstacle north-west of the spawn | solid |
      | afrolabs open space | obstacle north of the spawn      | solid |
      | afrolabs open space | obstacle north-east of the spawn | solid |
      | afrolabs open space | open floor east of the spawn     | open  |
