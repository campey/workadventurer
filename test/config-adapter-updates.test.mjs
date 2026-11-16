import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig, configToEnv, writeConfigField } from "../src/config.mjs";

function tmpConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-config-"));
  const file = path.join(dir, "nested", "config.json");
  if (contents !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(contents));
  }
  return { dir, file };
}

async function withEnv(value, fn) {
  const saved = process.env.WA_ADAPTER_UPDATES;
  if (value === undefined) delete process.env.WA_ADAPTER_UPDATES;
  else process.env.WA_ADAPTER_UPDATES = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.WA_ADAPTER_UPDATES;
    else process.env.WA_ADAPTER_UPDATES = saved;
  }
}

test("adapterUpdates defaults to ask", async () => {
  const { dir, file } = tmpConfig();
  await withEnv(undefined, () => {
    assert.equal(resolveConfig({}, file).adapterUpdates, "ask");
  });
  fs.rmSync(dir, { recursive: true });
});

test("adapterUpdates: file < env < flag", async () => {
  const { dir, file } = tmpConfig({ adapterUpdates: "auto" });
  await withEnv(undefined, () => {
    assert.equal(resolveConfig({}, file).adapterUpdates, "auto");
  });
  await withEnv("never", () => {
    assert.equal(resolveConfig({}, file).adapterUpdates, "never");
    assert.equal(resolveConfig({ adapterUpdates: "ask" }, file).adapterUpdates, "ask");
  });
  fs.rmSync(dir, { recursive: true });
});

test("adapterUpdates: junk values fall back to ask", async () => {
  const { dir, file } = tmpConfig({ adapterUpdates: "sometimes" });
  await withEnv(undefined, () => {
    assert.equal(resolveConfig({}, file).adapterUpdates, "ask");
  });
  await withEnv("bogus", () => {
    assert.equal(resolveConfig({}, file).adapterUpdates, "ask");
  });
  fs.rmSync(dir, { recursive: true });
});

test("adapterUpdates travels to a spawned daemon", () => {
  assert.equal(configToEnv({ ...resolveConfig({ adapterUpdates: "auto" }) }).WA_ADAPTER_UPDATES, "auto");
});

test("writeConfigField creates the directory and file when missing", () => {
  const { dir, file } = tmpConfig();
  writeConfigField("adapterUpdates", "auto", file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { adapterUpdates: "auto" });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"], "no temp file left behind");
  fs.rmSync(dir, { recursive: true });
});

test("writeConfigField keeps the other fields", () => {
  const { dir, file } = tmpConfig({ name: "bob", port: 9000, adapterUpdates: "ask" });
  writeConfigField("adapterUpdates", "auto", file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    name: "bob",
    port: 9000,
    adapterUpdates: "auto",
  });
  fs.rmSync(dir, { recursive: true });
});

test("writeConfigField refuses an invalid-JSON file and leaves its bytes alone", () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bad = '{ "name": "bob", "port": 9000,, }';
  fs.writeFileSync(file, bad);
  assert.throws(
    () => writeConfigField("adapterUpdates", "auto", file),
    (e) => e.message.includes(file) && e.message.includes("untouched") && e.message.includes("WA_ADAPTER_UPDATES=auto")
  );
  assert.equal(fs.readFileSync(file, "utf8"), bad);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
  fs.rmSync(dir, { recursive: true });
});

test("writeConfigField refuses a non-object JSON file (array, null) and leaves it alone", () => {
  for (const body of ["[1,2]", "null", '"str"']) {
    const { dir, file } = tmpConfig();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    assert.throws(() => writeConfigField("adapterUpdates", "auto", file), /not a JSON object/);
    assert.equal(fs.readFileSync(file, "utf8"), body);
    fs.rmSync(dir, { recursive: true });
  }
});

test("writeConfigField refuses an unreadable path (a directory) rather than overwriting", () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(file, { recursive: true }); // config.json is a directory: read fails with EISDIR
  assert.throws(() => writeConfigField("adapterUpdates", "auto", file), /cannot read it/);
  assert.ok(fs.statSync(file).isDirectory());
  fs.rmSync(dir, { recursive: true });
});

test("resolveConfig still reads a broken file leniently", () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ nope");
  assert.equal(resolveConfig({}, file).adapterUpdates, "ask");
  fs.rmSync(dir, { recursive: true });
});
