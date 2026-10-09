import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTranscriptSink } from "../src/stt-transcript.mjs";
import { resolveConfig, configToEnv } from "../src/config.mjs";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "transcript-")), "t.jsonl");
const lines = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("appends one JSONL line per final with ts, speaker and text", () => {
  const f = tmp();
  const sink = makeTranscriptSink(f, { now: () => new Date("2026-10-09T10:00:00Z") });
  sink({ text: "hello there", final: true }, "David");
  assert.deepEqual(lines(f), [{ ts: "2026-10-09T10:00:00.000Z", speaker: "David", text: "hello there" }]);
});

test("ignores partials and empty finals", () => {
  const f = tmp();
  const sink = makeTranscriptSink(f);
  sink({ text: "hel", final: false }, "David");
  sink({ text: "", final: true }, "David");
  sink({ text: "   ", final: true }, "David");
  sink({ text: "real one", final: true }, "David");
  assert.deepEqual(lines(f).map((l) => l.text), ["real one"]);
});

test("appends across sinks instead of truncating, and creates missing directories", () => {
  const f = path.join(path.dirname(tmp()), "deep", "nested", "t.jsonl");
  makeTranscriptSink(f)({ text: "one", final: true }, "A");
  makeTranscriptSink(f)({ text: "two", final: true }, "B");
  assert.deepEqual(lines(f).map((l) => `${l.speaker}:${l.text}`), ["A:one", "B:two"]);
});

test("a failing write never throws into the audio path", () => {
  const sink = makeTranscriptSink("/dev/null/cannot/write.jsonl", { onError: () => {} });
  assert.doesNotThrow(() => sink({ text: "x", final: true }, "A"));
});

test("config: transcript is unset by default and reaches a spawned daemon via WA_STT_TRANSCRIPT", () => {
  assert.equal(resolveConfig({}).transcript ?? null, null);
  assert.equal("WA_STT_TRANSCRIPT" in configToEnv(resolveConfig({})), false);
  const cfg = resolveConfig({ transcript: "/tmp/x.jsonl" });
  assert.equal(cfg.transcript, "/tmp/x.jsonl");
  assert.equal(configToEnv(cfg).WA_STT_TRANSCRIPT, "/tmp/x.jsonl");
});
