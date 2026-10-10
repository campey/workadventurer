Feature: Voice signalling
  The port event is `voiceSignal {kind: "webrtc"|"livekit", with}`. Voice is off unless an avatar
  asks for it (enableVoice), so ordinary scenarios never start audio.

  # source: probe voice-signalling, 2026-10-10 (confirms); live run 2026-10-10 passed; docs/livekit.md (escalation to LiveKit follows mesh size)
  Scenario: A proximity pair sets up WEBRTC voice and is not invited to LiveKit
    Given the world "afrolabs open space"
    And avatar A has voice enabled
    And avatar B has voice enabled
    And avatar A is in the world
    And avatar B is in the world
    And avatar B is 400 px away from avatar A
    When avatar A walks next to avatar B
    Then avatars A and B are in the same meeting
    And avatar A sees a WEBRTC voice signal
    And avatar B sees a WEBRTC voice signal
    And neither avatar A nor avatar B is invited to LiveKit
