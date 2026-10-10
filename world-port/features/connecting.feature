Feature: Connecting
  Background:
    Given the world "afrolabs open space"

  # source: probe version-hash (NOT YET RUN)
  Scenario: Our version is accepted
    When avatar A connects
    Then avatar A has joined the world

  # source: probe version-hash (NOT YET RUN)
  Scenario: A stale version is turned away
    When avatar A connects with the stale version "05489a87"
    Then avatar A is told a new version is available

  # source: docs/field-notes.md "Reconnect and server error screens (#56)"; fake-only (@fake); live run NOT YET RUN
  @fake
  Scenario: A version turned away after joining
    Given the server turns stale versions away after join
    When avatar A connects with the stale version "05489a87"
    Then avatar A is told a new version is available
