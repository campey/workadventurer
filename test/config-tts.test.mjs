import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, configToEnv } from "../src/config.mjs";

test("WA_TTS_PYTHON / WA_TTS_SAY resolve into config and travel to a spawned daemon", () => {
  const saved = { p: process.env.WA_TTS_PYTHON, s: process.env.WA_TTS_SAY };
  process.env.WA_TTS_PYTHON = "/opt/py/bin/python3";
  process.env.WA_TTS_SAY = "/opt/hs/src/say.py";
  try {
    const cfg = resolveConfig();
    assert.equal(cfg.ttsPython, "/opt/py/bin/python3");
    assert.equal(cfg.ttsSay, "/opt/hs/src/say.py");
    const env = configToEnv(cfg);
    assert.equal(env.WA_TTS_PYTHON, "/opt/py/bin/python3");
    assert.equal(env.WA_TTS_SAY, "/opt/hs/src/say.py");
  } finally {
    saved.p === undefined ? delete process.env.WA_TTS_PYTHON : (process.env.WA_TTS_PYTHON = saved.p);
    saved.s === undefined ? delete process.env.WA_TTS_SAY : (process.env.WA_TTS_SAY = saved.s);
  }
});

test("defaults are python3 and huggingsesame's say.py", () => {
  const cfg = resolveConfig();
  assert.ok(cfg.ttsPython);
  assert.ok(cfg.ttsSay.endsWith("say.py"));
});
