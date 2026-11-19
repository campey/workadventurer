import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { WorkAdventureClient } from "../src/wa-client.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAdapterFile } from "../src/catalog/adapter-file.mjs";
import { ADAPTERS, resolveAdapter } from "../src/adapters/index.mjs";
import { resolveConfig, configToEnv } from "../src/config.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-adapter-file-"));
const write = (name, text) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof text === "string" ? text : JSON.stringify(text));
  return f;
};
const good = {
  schema: 1, id: "cand-1", waVersion: "1.40.0", apiVersionHash: "deadbeef",
  server: "production", protoFamily: "wa-1.34",
};
const goodFile = () => write("good.json", good);

test("loadAdapterFile builds an adapter from a valid file", () => {
  const a = loadAdapterFile(goodFile(), ADAPTERS);
  assert.equal(a.id, "cand-1");
  assert.equal(a.apiVersionHashes[0], "deadbeef");
});

test("loadAdapterFile fails loudly: missing, bad JSON, invalid", () => {
  assert.throws(() => loadAdapterFile(path.join(dir, "nope.json"), ADAPTERS), /cannot read/);
  assert.throws(() => loadAdapterFile(write("junk.json", "{nope"), ADAPTERS), /not valid JSON/);
  assert.throws(() => loadAdapterFile(write("inv.json", { ...good, apiVersionHash: "XX" }), ADAPTERS), /invalid.*apiVersionHash/);
});

const probeHit = async () => ({ kind: "release", minor: "1.34", raw: "v1.34.0", hash: ADAPTERS["wa-1.34"].apiVersionHashes[0] });

test("resolveAdapter: file adapter wins over probe, cache and built-in hash; probe not run", async () => {
  const fileAdapter = loadAdapterFile(goodFile(), ADAPTERS);
  let probed = false;
  const r = await resolveAdapter({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    fileAdapter,
    probeFn: async () => ((probed = true), probeHit()),
    cachedFor: async () => { throw new Error("cache must not be consulted"); },
  });
  assert.equal(r.adapter, fileAdapter);
  assert.match(r.why, /adapter file/);
  assert.equal(probed, false);
});

test("resolveAdapter: explicit target override still wins over the file", async () => {
  const fileAdapter = loadAdapterFile(goodFile(), ADAPTERS);
  const r = await resolveAdapter({ roomUrl: "https://x/@/a/b/c", fileAdapter, override: "wa-1.33", probeFn: async () => null });
  assert.equal(r.adapter, ADAPTERS["wa-1.33"]);
});

test("resolveAdapter: override 'auto' does not beat the file", async () => {
  const fileAdapter = loadAdapterFile(goodFile(), ADAPTERS);
  const r = await resolveAdapter({ roomUrl: "https://x/@/a/b/c", fileAdapter, override: "auto", probeFn: probeHit });
  assert.equal(r.adapter, fileAdapter);
});

test("config: adapterFile from flag > env > config file, made absolute; reaches the daemon env", () => {
  const cfgFile = write("config.json", { adapterFile: "/from/config.json" });
  const saved = process.env.WA_ADAPTER_FILE;
  try {
    delete process.env.WA_ADAPTER_FILE;
    assert.equal(resolveConfig({}, cfgFile).adapterFile, "/from/config.json");
    process.env.WA_ADAPTER_FILE = "/from/env.json";
    assert.equal(resolveConfig({}, cfgFile).adapterFile, "/from/env.json");
    const c = resolveConfig({ adapterFile: "/from/flag.json" }, cfgFile);
    assert.equal(c.adapterFile, "/from/flag.json");
    assert.equal(configToEnv(c).WA_ADAPTER_FILE, "/from/flag.json");
    process.env.WA_ADAPTER_FILE = path.relative(process.cwd(), "/tmp/rel.json");
    assert.equal(resolveConfig({}, cfgFile).adapterFile, "/tmp/rel.json");
    delete process.env.WA_ADAPTER_FILE;
    assert.equal(resolveConfig({}, write("empty.json", {})).adapterFile, null);
    assert.equal("WA_ADAPTER_FILE" in configToEnv(resolveConfig({}, write("empty.json", {}))), false);
  } finally {
    if (saved === undefined) delete process.env.WA_ADAPTER_FILE;
    else process.env.WA_ADAPTER_FILE = saved;
  }
});

test("WorkAdventureClient.connect resolves the injected fileAdapter without probing", async () => {
  const fileAdapter = loadAdapterFile(goodFile(), ADAPTERS);
  const c = new WorkAdventureClient({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    fileAdapter,
    fetch: async () => { throw new Error("stop after resolve"); },
  });
  await assert.rejects(c.connect());
  assert.equal(c.adapter, fileAdapter);
});

test("selfcheck with an invalid adapter file exits non-zero with a clear error", () => {
  const r = spawnSync(process.execPath, ["scripts/selfcheck.mjs", "--adapter-file", write("bad.json", { ...good, schema: 2 })], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /adapter file .*bad\.json.*schema must be 1/);
});

test("wa join with an unreadable adapter file exits non-zero before starting a daemon", () => {
  const r = spawnSync(process.execPath, ["bin/wa.mjs", "join", "--adapter-file", path.join(dir, "missing.json"), "--port", "58123"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read/);
});

test("LiveWorld with an invalid adapter file throws at construction", async () => {
  const { LiveWorld } = await import("../world-port/live/live-world.mjs");
  assert.throws(() => new LiveWorld({ roomUrl: "https://x/@/a/b/c", name: "t", adapterFile: path.join(dir, "missing.json") }), /cannot read/);
});

test("config: a relative adapterFile in the config file resolves against the config file's directory", () => {
  const saved = process.env.WA_ADAPTER_FILE;
  delete process.env.WA_ADAPTER_FILE;
  try {
    const sub = path.join(dir, "cfgdir");
    fs.mkdirSync(sub, { recursive: true });
    const f = path.join(sub, "config.json");
    fs.writeFileSync(f, JSON.stringify({ adapterFile: "adapters/c.json" }));
    assert.equal(resolveConfig({}, f).adapterFile, path.join(sub, "adapters", "c.json"));
    assert.equal(resolveConfig({ adapterFile: "x.json" }, f).adapterFile, path.resolve("x.json"));
  } finally {
    if (saved !== undefined) process.env.WA_ADAPTER_FILE = saved;
  }
});
