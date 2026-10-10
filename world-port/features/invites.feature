Feature: Meeting invitations
  Invitations are matched by avatar name; the sender's identity never appears in output.

  Background:
    Given the world "afrolabs open space"
    And avatar A is in the world
    And avatar B is in the world
    And avatar B is 400 px away from avatar A

  # source: docs/field-notes.md "Invite over" (MeetingInvitation); live run NOT YET RUN
  Scenario: An invitation is received, accepted and brings both avatars together
    When avatar A invites avatar B
    Then avatar B is told avatar A invited them
    When avatar B accepts the invitation from avatar A
    Then avatar A is told avatar B accepted
    And avatars A and B are in the same meeting

  # source: port contract (invite() throws for an unknown player; holds on fake and live)
  Scenario: Inviting someone who is not in the world is an error
    Then avatar A cannot invite "wa-probe-nobody"
