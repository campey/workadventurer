import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS } from "../src/adapters/index.mjs";
import { validateAdapterFile, buildAdapter, HASH_RE, BOUNDS } from "../src/catalog/schema.mjs";

const good = () => ({
  schema: 1,
  id: "wa-1.34.5",
  waVersion: "1.34",
  apiVersionHash: "0123abcd",
  server: "production",
  protoFamily: "wa-1.34",
  meeting: { areaDwellMs: 100, areaLingerMs: 200 },
  movement: { walkPxPerS: 170, runPxPerS: 440 },
});

const reject = (file, field) => {
  const r = validateAdapterFile(file, ADAPTERS);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(field));
};
const withHs = (query) => ({ ...good(), handshake: { query } });

test("exports the regex and bounds", () => {
  assert.ok(HASH_RE.test("f4cfe455"));
  assert.deepEqual(BOUNDS, { dwellMs: [0, 10000], lingerMs: [0, 10000], speed: [50, 1000] });
});

test("a good file passes and normalises", () => {
  const r = validateAdapterFile(good(), ADAPTERS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.file, good());
});

test("wa-master is a valid protoFamily", () => {
  assert.equal(validateAdapterFile({ ...good(), protoFamily: "wa-master", server: "staging" }, ADAPTERS).ok, true);
});

test("rejects non-object", () => {
  for (const v of [null, "x", 3, [], undefined]) assert.equal(validateAdapterFile(v, ADAPTERS).ok, false);
  reject(null, "file");
});
test("rejects schema !== 1", () => reject({ ...good(), schema: 2 }, "schema"));
test("rejects bad hash", () => {
  reject({ ...good(), apiVersionHash: "XYZ" }, "apiVersionHash");
  reject({ ...good(), apiVersionHash: "0123abcde" }, "apiVersionHash");
});
test("rejects unknown protoFamily", () => reject({ ...good(), protoFamily: "wa-9.9" }, "protoFamily"));
test("rejects bad server", () => reject({ ...good(), server: "elsewhere" }, "server"));
test("rejects bad id and waVersion", () => {
  reject({ ...good(), id: "" }, "id");
  reject({ ...good(), waVersion: 1.34 }, "waVersion");
});
test("rejects areaDwellMs out of range", () =>
  reject({ ...good(), meeting: { areaDwellMs: 99999 } }, "areaDwellMs"));
test("rejects areaLingerMs negative", () =>
  reject({ ...good(), meeting: { areaLingerMs: -1 } }, "areaLingerMs"));
test("rejects non-integer dwell", () => reject({ ...good(), meeting: { areaDwellMs: 1.5 } }, "areaDwellMs"));
test("rejects walkPxPerS non-number", () =>
  reject({ ...good(), movement: { walkPxPerS: "fast" } }, "walkPxPerS"));
test("rejects runPxPerS out of range", () =>
  reject({ ...good(), movement: { runPxPerS: 5000 } }, "runPxPerS"));

test("extra fields are dropped", () => {
  const f = { ...good(), code: "process.exit()", meeting: { ...good().meeting, evil: 1 } };
  f.movement = { ...f.movement, fly: 9 };
  const r = validateAdapterFile(f, ADAPTERS);
  assert.equal(r.ok, true);
  assert.equal("code" in r.file, false);
  assert.equal("evil" in r.file.meeting, false);
  assert.equal("fly" in r.file.movement, false);
});

test("handshake: too many parameters", () => {
  const q = {};
  for (let i = 0; i < 13; i++) q[`p${i}`] = "a";
  reject(withHs(q), "handshake");
});
test("handshake: 12 parameters ok", () => {
  const q = {};
  for (let i = 0; i < 12; i++) q[`p${i}`] = "a";
  assert.equal(validateAdapterFile(withHs(q), ADAPTERS).ok, true);
});
test("handshake: bad name", () => reject(withHs({ "bad name": "a" }), "handshake"));
test("handshake: long value", () => reject(withHs({ a: "x".repeat(65) }), "handshake"));
test("handshake: value with space or &", () => {
  reject(withHs({ a: "x y" }), "handshake");
  reject(withHs({ a: "x&y=1" }), "handshake");
});
test("handshake: non-string value", () => reject(withHs({ a: 1 }), "handshake"));
test("handshake: unknown placeholder", () => reject(withHs({ a: "{x}" }), "handshake"));
test("handshake: forbidden names", () => {
  for (const n of ["roomId", "version", "characterTextureIds", "token"]) reject(withHs({ [n]: "a" }), n);
});
test("handshake: forbidden names are matched case-insensitively", () => {
  for (const n of ["RoomId", "VERSION", "Token", "CharacterTextureIds", "ROOMID"]) reject(withHs({ [n]: "a" }), n);
});
test("handshake: not an object", () => {
  reject({ ...good(), handshake: "x" }, "handshake");
  reject({ ...good(), handshake: { query: [] } }, "handshake");
});

test("handshake query normalises and builds", () => {
  const query = { chatID: "", tabId2: "{tabId}", cid: "{uuid}" };
  const r = validateAdapterFile(withHs(query), ADAPTERS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.file.handshake.query, query);
  assert.deepEqual(buildAdapter(r.file, ADAPTERS).handshake.query, query);
});

test("buildAdapter lays the file over the base", () => {
  const before = structuredClone(ADAPTERS["wa-1.34"].meeting);
  const baseHashes = [...ADAPTERS["wa-1.34"].apiVersionHashes];
  const file = { ...good(), apiVersionHash: baseHashes[1], meeting: { areaDwellMs: 7 } };
  delete file.movement;
  const a = buildAdapter(validateAdapterFile(file, ADAPTERS).file, ADAPTERS);
  assert.equal(a.id, "wa-1.34.5");
  assert.equal(a.waVersion, "1.34");
  assert.equal(a.stability, "catalog");
  assert.equal(a.protoPath, ADAPTERS["wa-1.34"].protoPath);
  assert.deepEqual(a.apiVersionHashes, [baseHashes[1], ...baseHashes.filter((h) => h !== baseHashes[1])]);
  assert.equal(a.meeting.areaDwellMs, 7);
  assert.equal(a.meeting.areaLingerMs, before.areaLingerMs);
  assert.deepEqual(a.movement, ADAPTERS["wa-1.34"].movement);
  assert.equal("handshake" in a, false);
  assert.deepEqual(ADAPTERS["wa-1.34"].meeting, before);
  assert.deepEqual(ADAPTERS["wa-1.34"].apiVersionHashes, baseHashes);
});

test("buildAdapter works when the base has no movement", () => {
  const builtins = { "wa-x": { id: "wa-x", waVersion: "x", apiVersionHashes: ["aaaaaaaa"], meeting: { areaDwellMs: 1 } } };
  const f = { ...good(), protoFamily: "wa-x", movement: { walkPxPerS: 100 } };
  const r = validateAdapterFile(f, builtins);
  assert.equal(r.ok, true);
  const a = buildAdapter(r.file, builtins);
  assert.deepEqual(a.movement, { walkPxPerS: 100 });
  assert.deepEqual(a.apiVersionHashes, ["0123abcd", "aaaaaaaa"]);
});
