// Runs the Python unit tests for scripts/stt_worker.py's pure logic under `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("stt_worker.py unit tests pass", () => {
  const r = spawnSync("python3", [fileURLToPath(new URL("./test_stt_worker.py", import.meta.url))], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
