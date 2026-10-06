import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWords, wer, scoreClip } from "../src/stt-score.mjs";

test("normalizeWords lowercases and strips punctuation but keeps apostrophes", () => {
  assert.deepEqual(normalizeWords("Let's meet, at the Fire-pit."), ["let's", "meet", "at", "the", "fire", "pit"]);
});

test("wer is 0 for an exact match modulo case/punctuation", () => {
  assert.equal(wer("The meeting starts.", "the meeting starts"), 0);
});

test("wer counts substitutions, insertions and deletions over reference length", () => {
  assert.equal(wer("a b c d", "a x c"), 0.5); // 1 substitution + 1 deletion
  assert.equal(wer("a b", "a b c d"), 1); // 2 insertions
});

test("wer is null when the reference is empty (undefined for must-be-empty clips)", () => {
  assert.equal(wer("", "anything"), null);
});

test("scoreClip on a must-be-empty clip counts every non-empty final as spurious", () => {
  const s = scoreClip({ expected: "", finals: ["Thank you.", "", "Okay."] });
  assert.equal(s.spurious, 2);
  assert.equal(s.wer, null);
});

test("scoreClip on a must-be-empty clip with no finals is clean", () => {
  const s = scoreClip({ expected: "", finals: [] });
  assert.equal(s.spurious, 0);
});

test("scoreClip flags non-Latin script when the expected text is Latin", () => {
  const s = scoreClip({ expected: "hello there", finals: ["대결 잎은 잎은"] });
  assert.equal(s.nonLatin, true);
  assert.equal(s.wer, 1.5); // 2 substitutions + 1 insertion over 2 reference words
});

test("scoreClip does not flag non-Latin when the expectation is itself non-Latin", () => {
  const s = scoreClip({ expected: "こんにちは", finals: ["こんにちは"] });
  assert.equal(s.nonLatin, false);
});

test("scoreClip flags a token run of 4+ as a loop", () => {
  const s = scoreClip({ expected: "stop", finals: ["stop stop stop stop stop"] });
  assert.equal(s.loop, true);
  assert.equal(scoreClip({ expected: "stop", finals: ["stop stop stop"] }).loop, false);
});

test("scoreClip with expected null checks only script and loops (no reference text)", () => {
  const bad = scoreClip({ expected: null, finals: ["و lnك الرحيم"] });
  assert.equal(bad.nonLatin, true);
  assert.equal(bad.wer, null);
  assert.equal(bad.spurious, 0);
  assert.equal(scoreClip({ expected: null, finals: ["foo foo foo foo foo"] }).loop, true);
  const ok = scoreClip({ expected: null, finals: ["perfectly fine words", "more of them"] });
  assert.deepEqual([ok.nonLatin, ok.loop, ok.spurious, ok.wer], [false, false, 0, null]);
  assert.equal(scoreClip({ expected: null, finals: [] }).spurious, 0);
});

test("scoreClip flags undecodable U+FFFD output as wrong-script garbage", () => {
  assert.equal(scoreClip({ expected: "hello", finals: ["Yeah ����"] }).nonLatin, true);
});

test("scoreClip flags a single character repeated many times as a loop", () => {
  assert.equal(scoreClip({ expected: "on", finals: ["On" + "n".repeat(40)] }).loop, true);
  assert.equal(scoreClip({ expected: "so", finals: ["sooooo, wait... what"] }).loop, false);
});

test("scoreClip flags a no-space repeated substring (dodododo…) as a loop", () => {
  assert.equal(scoreClip({ expected: "bar", finals: ["I bar" + "do".repeat(30)] }).loop, true);
  assert.equal(scoreClip({ expected: "care", finals: ["and always be" + "care".repeat(20)] }).loop, true);
  assert.equal(scoreClip({ expected: "ha", finals: ["hahaha that was funny"] }).loop, false);
});

test("scoreClip joins multiple finals for WER on speech clips", () => {
  const s = scoreClip({ expected: "the quick brown fox", finals: ["the quick", "brown fox"] });
  assert.equal(s.wer, 0);
  assert.equal(s.spurious, 0);
});
