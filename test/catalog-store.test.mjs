import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "../src/adapters/index.mjs";
import { cachedHashes, defaultCacheDir, loadCached, saveCached } from "../src/catalog/store.mjs";

const builtins = ADAPTERS;
const family = Object.keys(ADAPTERS)[0];
const fileText = (over = {}) =>
  JSON.stringify({ schema: 1, id: "wa-test", waVersion: "1.99", apiVersionHash: "abcdef12", server: "production", protoFamily: family, ...over });
const tmp = () => mkdtemp(join(tmpdir(), "wa-store-"));

test("defaultCacheDir ends in .workadventurer/adapters", () => {
  assert.match(defaultCacheDir().replaceAll("\\", "/"), /\.workadventurer\/adapters$/);
});

test("save then load round-trips to a built adapter", async () => {
  const dir = await tmp();
  await saveCached("abcdef12", fileText(), { dir });
  const a = await loadCached("abcdef12", { dir, builtins });
  assert.equal(a.id, "wa-test");
  assert.equal(a.stability, "catalog");
  assert.equal(a.apiVersionHashes[0], "abcdef12");
});

test("save creates a missing directory", async () => {
  const dir = join(await tmp(), "nested", "adapters");
  await saveCached("abcdef12", fileText(), { dir });
  assert.deepEqual(await readdir(dir), ["abcdef12.json"]);
});

test("missing, corrupt, mismatched and out-of-bounds files load as null", async () => {
  const dir = await tmp();
  assert.equal(await loadCached("abcdef12", { dir, builtins }), null);
  await writeFile(join(dir, "abcdef12.json"), "{not json");
  assert.equal(await loadCached("abcdef12", { dir, builtins }), null);
  await writeFile(join(dir, "11111111.json"), fileText()); // field says abcdef12
  assert.equal(await loadCached("11111111", { dir, builtins }), null);
  await writeFile(join(dir, "22222222.json"), fileText({ apiVersionHash: "22222222", movement: { walkPxPerS: 1e9 } }));
  assert.equal(await loadCached("22222222", { dir, builtins }), null);
  await writeFile(join(dir, "33333333.json"), "null");
  assert.equal(await loadCached("33333333", { dir, builtins }), null);
  assert.equal(await loadCached("../etc/passwd", { dir, builtins }), null);
  assert.equal(await loadCached("ABCDEF12", { dir, builtins }), null);
});

test("saveCached leaves no tmp files; concurrent saves leave one valid file", async () => {
  const dir = await tmp();
  await Promise.all(Array.from({ length: 8 }, () => saveCached("abcdef12", fileText(), { dir })));
  assert.deepEqual(await readdir(dir), ["abcdef12.json"]);
  assert.equal(JSON.parse(await readFile(join(dir, "abcdef12.json"), "utf8")).id, "wa-test");
  assert.ok(await loadCached("abcdef12", { dir, builtins }));
});

test("cachedHashes lists only hash-named json files, and is empty for a missing dir", async () => {
  const dir = await tmp();
  await saveCached("abcdef12", fileText(), { dir });
  await writeFile(join(dir, "notes.json"), "{}");
  await writeFile(join(dir, "abcdef12.json.tmp"), "{}");
  await writeFile(join(dir, "ABCDEF12.json"), "{}");
  assert.deepEqual([...(await cachedHashes({ dir }))], ["abcdef12"]);
  assert.equal((await cachedHashes({ dir: join(dir, "nope") })).size, 0);
});
