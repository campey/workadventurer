Feature: Connecting
  Background:
    Given the world "afrolabs open space"

  Scenario: Our version is accepted
    When avatar A connects
    Then avatar A has joined the world

  Scenario: A stale version is turned away
    When avatar A connects with the stale version "05489a87"
    Then avatar A is told a new version is available
