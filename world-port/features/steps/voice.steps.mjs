import assert from "node:assert/strict";
import { Given, Then } from "@cucumber/cucumber";

const role = (r) => r.toUpperCase();

// Must run before "is in the world": voice is attached to the avatar before it connects.
// scenario: voice:A proximity pair sets up WEBRTC voice and is not invited to LiveKit
Given("avatar {word} has voice enabled", async function (r) {
  await (await this.avatar(role(r))).enableVoice();
});

// scenario: voice:A proximity pair sets up WEBRTC voice and is not invited to LiveKit
Then("avatar {word} sees a WEBRTC voice signal", async function (r) {
  await this.observe(role(r), "voiceSignal", (s) => s.kind === "webrtc", { timeoutMs: 20000 });
});

// A negative: asserted on each avatar's whole event log, after the positive signals have arrived.
// scenario: voice:A proximity pair sets up WEBRTC voice and is not invited to LiveKit
Then("neither avatar {word} nor avatar {word} is invited to LiveKit", async function (r1, r2) {
  for (const r of [role(r1), role(r2)]) {
    await this.avatar(r);
    const kinds = (this.events.get(r) ?? []).filter((e) => e.event === "voiceSignal").map((e) => e.payload.kind);
    assert.ok(!kinds.includes("livekit"), `avatar ${r} was invited to LiveKit (voice signals: ${kinds.join(", ")})`);
  }
});
