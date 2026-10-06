import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PcmTee } from "../src/pcm-tee.mjs";

test("PcmTee writes pushed PCM to a file and records events with the byte offset at the time", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pcmtee-"));
  const tee = new PcmTee(dir, "alice");
  tee.pcm(Buffer.alloc(3200)); // 0.1s @ 16kHz s16
  tee.event({ type: "final", text: "hello" });
  tee.pcm(Buffer.alloc(1600));
  await tee.close();

  const files = readdirSync(dir).sort();
  assert.equal(files.length, 2);
  const pcm = readFileSync(path.join(dir, files.find((f) => f.endsWith(".pcm"))));
  assert.equal(pcm.length, 4800);
  const events = readFileSync(path.join(dir, files.find((f) => f.endsWith(".jsonl"))), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.type, e.text, e.byteOffset]), [["final", "hello", 3200]]);
});

test("PcmTee is inert when no directory is given", async () => {
  const tee = new PcmTee(undefined, "alice");
  tee.pcm(Buffer.alloc(10));
  tee.event({ type: "final", text: "x" });
  await tee.close(); // no throw
});
