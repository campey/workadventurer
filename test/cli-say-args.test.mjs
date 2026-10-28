// `wa say "-5 degrees"`: text that starts with a dash is parsed as a flag by
// util.parseArgs. It must fail with a one-line hint about `--`, not a stack
// trace. (Fails before any daemon is touched, so nothing is started.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WA = fileURLToPath(new URL("../bin/wa.mjs", import.meta.url));

test("a dash-leading word in unquoted say text gets a hint, not a stack trace", () => {
  const r = spawnSync(process.execPath, [WA, "say", "-5", "degrees", "out"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /wa say -- /);
  assert.doesNotMatch(r.stderr, /ERR_PARSE_ARGS|at .*\.mjs:\d+/);
});
