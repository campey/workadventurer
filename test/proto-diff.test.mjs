import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffProtos } from "../scripts/proto-diff.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-"));
const write = (n, body) => { const p = path.join(dir, n); fs.writeFileSync(p, `syntax = "proto3";\n${body}`); return p; };
const OLD = write("old.proto", "message Ping { string id = 1; string legacyNote = 2; }\nmessage Gone { string x = 1; }\nenum Kind { A = 0; B = 1; }");
const NEW = write("new.proto", "message Ping { string id = 1; string extra = 3; }\nenum Kind { A = 0; B = 1; C = 2; }");

test("wire-breaking items are attributed to the client that mentions them", () => {
  const d = diffProtos(OLD, NEW, {
    sources: { src: ["const x = Ping; x.legacyNote"], android: ["class Gone(val x: String)"] },
  });
  const by = Object.fromEntries(d.breaking.map((b) => [b.text.split(" ").slice(0, 3).join(" "), b.usedBy]));
  assert.deepEqual(by["REMOVED field Ping.legacyNote"], ["src"]);
  assert.deepEqual(by["REMOVED message Gone"], ["android"]);
  assert.deepEqual([...d.usedBy].sort(), ["android", "src"]);
});

test("additive changes never count, and an unscanned client is not consulted", () => {
  const d = diffProtos(OLD, NEW, { sources: { src: ["nothing relevant"] } });
  assert.equal(d.usedBy.size, 0);
  assert.ok(d.additive.some((l) => l.includes("Ping.extra")));
  assert.ok(d.additive.some((l) => l.includes("Kind.C")));
  const onlyAndroid = diffProtos(OLD, NEW, { sources: { android: ["Gone"] } });
  assert.deepEqual([...onlyAndroid.usedBy], ["android"]);
});

test("a plain field name counts only with its parent message mentioned", () => {
  const d = diffProtos(OLD, NEW, { sources: { android: ["val legacyNote = 1"] } });
  assert.equal(d.usedBy.size, 0);
});

test("android use needs message and field in ONE file (ruling R9)", () => {
  const split = diffProtos(OLD, NEW, { sources: { android: ["class Ping { val a = 1 }", "val x = legacyNote"] } });
  assert.equal(split.usedBy.size, 0, "mentioned only in separate files");
  const together = diffProtos(OLD, NEW, { sources: { android: ["Ping(legacyNote = 1)"] } });
  assert.deepEqual([...together.usedBy], ["android"]);
  const gone = diffProtos(OLD, NEW, { sources: { android: ["val gone = 1"] } });
  assert.deepEqual([...gone.usedBy], ["android"], "a removed message counts by its lower-case name too");
  const removedNowhere = diffProtos(OLD, NEW, { sources: { android: ["nothing"] } });
  assert.equal(removedNowhere.usedBy.size, 0);
});
