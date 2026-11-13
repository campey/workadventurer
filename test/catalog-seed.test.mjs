import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rebuildIndex } from "../scripts/catalog-index.mjs";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../src/adapters/index.mjs";
import { validateAdapterFile } from "../src/catalog/schema.mjs";
import { fetchAdapterFile, fetchIndex } from "../src/catalog/client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogDir = path.join(root, "catalog");
const script = path.join(root, "scripts", "catalog-index.mjs");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const files = fs.readdirSync(path.join(catalogDir, "adapters")).filter((f) => f.endsWith(".json")).sort();
const SEEDS = { "23c8eb8c": "production", b82fc568: "production", "62e25483": "production", f4cfe455: "production", d2d82672: "staging" };

test("the seed has exactly the known hashes", () => {
  assert.deepEqual(files, Object.keys(SEEDS).map((h) => `${h}.json`).sort());
});

test("every seed file validates and its hash belongs to its protoFamily", () => {
  for (const f of files) {
    const hash = f.replace(".json", "");
    const checked = validateAdapterFile(readJson(path.join(catalogDir, "adapters", f)), ADAPTERS);
    assert.equal(checked.ok, true, `${f}: ${checked.reason}`);
    assert.equal(checked.file.apiVersionHash, hash);
    assert.equal(checked.file.server, SEEDS[hash]);
    assert.ok(ADAPTERS[checked.file.protoFamily].apiVersionHashes.includes(hash), `${f} not in ${checked.file.protoFamily}`);
  }
});

test("seed meeting/movement match the built-in adapter they mirror", () => {
  for (const f of files) {
    const file = readJson(path.join(catalogDir, "adapters", f));
    const base = ADAPTERS[file.protoFamily];
    assert.equal(file.meeting.areaDwellMs, base.meeting.areaDwellMs);
    assert.equal(file.meeting.areaLingerMs, base.meeting.areaLingerMs);
    if (base.movement) assert.deepEqual(file.movement, base.movement);
  }
});

test("index has one correct entry per file", () => {
  const index = readJson(path.join(catalogDir, "index.json"));
  assert.equal(index.schema, 1);
  assert.deepEqual(Object.keys(index.entries), Object.keys(index.entries).sort());
  assert.deepEqual(Object.keys(index.entries), files.map((f) => f.replace(".json", "")).sort());
  for (const [hash, e] of Object.entries(index.entries)) {
    const bytes = fs.readFileSync(path.join(catalogDir, "adapters", `${hash}.json`));
    assert.equal(e.status, "ok");
    assert.equal(e.server, SEEDS[hash]);
    assert.equal(e.file, `adapters/${hash}.json`);
    assert.equal(e.sha256, sha(bytes));
    assert.equal(e.gate, null);
    assert.equal(e.issue, null);
  }
  assert.equal(index.entries.d2d82672.version, "master@118dd84c");
  assert.equal(index.entries.f4cfe455.version, "v1.34.4");
});

test("the real client loads the seed over HTTP", async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(catalogDir, new URL(req.url, "http://x").pathname);
    if (!p.startsWith(catalogDir) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(fs.readFileSync(p));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/index.json`;
  const got = await fetchIndex({ url });
  assert.equal(got.ok, true, got.reason);
  assert.equal(Object.keys(got.index.entries).length, files.length);
  for (const hash of ["f4cfe455", "d2d82672"]) {
    const r = await fetchAdapterFile({ indexUrl: url, hash, entry: got.index.entries[hash], builtins: ADAPTERS });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.file.apiVersionHash, hash);
  }
});

test("catalog-index is idempotent apart from updated and keeps placeholders", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-seed-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.cpSync(catalogDir, tmp, { recursive: true });
  const indexPath = path.join(tmp, "index.json");
  const placeholder = { status: "needs-attention", server: "production", version: "v1.35.0", gate: "selfcheck", issue: 999 };
  const seeded = readJson(indexPath);
  seeded.entries["0badc0de"] = placeholder;
  fs.writeFileSync(indexPath, JSON.stringify(seeded));
  execFileSync("node", [script, tmp]);
  const first = fs.readFileSync(indexPath, "utf8");
  execFileSync("node", [script, tmp]);
  const strip = (t) => { const j = JSON.parse(t); delete j.updated; return j; };
  assert.deepEqual(strip(fs.readFileSync(indexPath, "utf8")), strip(first));
  const after1 = JSON.parse(first);
  assert.deepEqual(after1.entries["0badc0de"], placeholder);
  assert.ok(first.endsWith("\n"));
  assert.deepEqual(Object.keys(after1.entries), Object.keys(after1.entries).sort());
  delete after1.entries["0badc0de"];
  delete after1.updated;
  const orig = readJson(path.join(catalogDir, "index.json"));
  delete orig.updated;
  assert.deepEqual(after1, orig);
});

test("catalog-index fails loudly on a bad file or a misnamed file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-seed-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.cpSync(catalogDir, tmp, { recursive: true });
  const good = readJson(path.join(tmp, "adapters", "f4cfe455.json"));
  fs.writeFileSync(path.join(tmp, "adapters", "11111111.json"), JSON.stringify(good));
  assert.throws(() => execFileSync("node", [script, tmp], { stdio: "pipe" }), /11111111/);
  fs.rmSync(path.join(tmp, "adapters", "11111111.json"));
  fs.writeFileSync(path.join(tmp, "adapters", "f4cfe455.json"), JSON.stringify({ ...good, server: "nope" }));
  assert.throws(() => execFileSync("node", [script, tmp], { stdio: "pipe" }), /f4cfe455/);
});

const tempCatalog = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-seed-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.cpSync(catalogDir, tmp, { recursive: true });
  return tmp;
};

test("rebuildIndex refuses a corrupt or non-index index.json and leaves it untouched", () => {
  for (const bad of ['{"schema": 1, "entries": {"0badc0', "[]", '{"schema":1}', '{"schema":1,"entries":[]}']) {
    const tmp = tempCatalog();
    const p = path.join(tmp, "index.json");
    fs.writeFileSync(p, bad);
    assert.throws(() => rebuildIndex(tmp), /index\.json.*could not be read.*nothing was written/s);
    assert.equal(fs.readFileSync(p, "utf8"), bad);
  }
  const tmp = tempCatalog();
  fs.writeFileSync(path.join(tmp, "index.json"), "{");
  assert.throws(() => execFileSync("node", [script, tmp], { stdio: "pipe" }), /could not be read/);
});

test("rebuildIndex builds a fresh index when index.json is missing", () => {
  const tmp = tempCatalog();
  fs.rmSync(path.join(tmp, "index.json"));
  const index = rebuildIndex(tmp);
  assert.equal(Object.keys(index.entries).length, files.length);
  assert.ok(fs.existsSync(path.join(tmp, "index.json")));
});

test("an ok entry replaces a needs-attention placeholder for the same hash", () => {
  const tmp = tempCatalog();
  const p = path.join(tmp, "index.json");
  const seeded = readJson(p);
  seeded.entries.f4cfe455 = { status: "needs-attention", server: "production", version: "v1.34.9", gate: "selfcheck", issue: 5 };
  fs.writeFileSync(p, JSON.stringify(seeded));
  const index = rebuildIndex(tmp);
  assert.equal(index.entries.f4cfe455.status, "ok");
  assert.equal(index.entries.f4cfe455.file, "adapters/f4cfe455.json");
  assert.equal(index.entries.f4cfe455.issue, null);
});
