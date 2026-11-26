import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { rebuildIndex, backfillAdded } from "../scripts/catalog-index.mjs";
import { isInstant } from "../src/catalog/schema.mjs";
import { fetchIndex } from "../src/catalog/client.mjs";

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "catalog");
const seed = JSON.parse(fs.readFileSync(path.join(SRC, "adapters", "23c8eb8c.json"), "utf8"));
const readIndex = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
const writeAdapter = (dir, hash, over = {}) => {
  fs.mkdirSync(path.join(dir, "adapters"), { recursive: true });
  fs.writeFileSync(path.join(dir, "adapters", `${hash}.json`), JSON.stringify({ ...seed, apiVersionHash: hash, ...over }, null, 2) + "\n");
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cidx-"));

test("added: set once for a new ok entry, kept across rebuilds, never rewritten", () => {
  const dir = tmp();
  writeAdapter(dir, "aaaaaaa1");
  rebuildIndex(dir, { now: new Date("2026-02-01T00:00:00Z") });
  assert.equal(readIndex(dir).entries.aaaaaaa1.added, "2026-02-01T00:00:00.000Z");
  writeAdapter(dir, "aaaaaaa2");
  rebuildIndex(dir, { now: new Date("2026-03-01T00:00:00Z") });
  const e = readIndex(dir).entries;
  assert.equal(e.aaaaaaa1.added, "2026-02-01T00:00:00.000Z"); // not rewritten
  assert.equal(e.aaaaaaa2.added, "2026-03-01T00:00:00.000Z");
});

test("added: a legacy ok entry without it stays without (the backfill is the one place that sets it); a placeholder turning ok gets one", () => {
  const dir = tmp();
  writeAdapter(dir, "aaaaaaa1");
  rebuildIndex(dir);
  const idx = readIndex(dir);
  delete idx.entries.aaaaaaa1.added;
  idx.entries.aaaaaaa2 = { status: "needs-attention", server: "staging", version: "master@abc1234", gate: "x", issue: null, commit: "b".repeat(40) };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx));
  writeAdapter(dir, "aaaaaaa2");
  rebuildIndex(dir, { now: new Date("2026-04-01T00:00:00Z") });
  const e = readIndex(dir).entries;
  assert.equal(e.aaaaaaa1.added, undefined);
  assert.equal(e.aaaaaaa2.added, "2026-04-01T00:00:00.000Z");
});

test("a malformed added in the index is not carried over; seenOn is preserved", () => {
  const dir = tmp();
  writeAdapter(dir, "aaaaaaa1");
  rebuildIndex(dir);
  const idx = readIndex(dir);
  idx.entries.aaaaaaa1.added = "yesterday";
  idx.entries.aaaaaaa1.seenOn = [{ server: "production", version: "v1.35.0", checked: "2026-11-26T00:00:00.000Z", gate: "passed" }];
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx));
  rebuildIndex(dir);
  const e = readIndex(dir).entries.aaaaaaa1;
  assert.equal(e.added, undefined);
  assert.equal(e.seenOn.length, 1);
});

test("isInstant: only ISO instants with a zone", () => {
  for (const v of ["2026-11-13T12:40:05Z", "2026-11-13T12:40:05.000Z", "2026-11-13T12:40:05+02:00"]) assert.equal(isInstant(v), true, v);
  for (const v of ["2026-11-13", "yesterday", "2026-13-45T00:00:00Z", 1763037605000, null, "2026-11-13T12:40:05", "2026-11-13T12:40:05Z".repeat(3)]) assert.equal(isInstant(v), false, String(v));
});

test("clients keep added only when it parses as an instant, and drop seenOn", async () => {
  const sha = "0".repeat(64);
  const entry = (extra) => ({ status: "ok", server: "staging", version: "master@abc1234", file: "adapters/x.json", sha256: sha, ...extra });
  const body = { schema: 1, entries: {
    aaaaaaa1: entry({ added: "2026-11-13T12:40:05.000Z", seenOn: [{ server: "production" }] }),
    aaaaaaa2: entry({ added: "someday" }),
    aaaaaaa3: entry({}),
    aaaaaaa4: { status: "needs-attention", server: "staging", added: "bad" },
  } };
  const fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  const r = await fetchIndex({ url: "https://example.test/index.json", fetch });
  assert.equal(r.ok, true);
  const e = r.index.entries;
  assert.equal(e.aaaaaaa1.added, "2026-11-13T12:40:05.000Z");
  assert.equal(e.aaaaaaa1.seenOn, undefined);
  assert.equal("added" in e.aaaaaaa2, false);
  assert.equal("added" in e.aaaaaaa3, false);
  assert.equal("added" in e.aaaaaaa4, false);
  assert.equal(e.aaaaaaa2.status, "ok");
});

function git(cwd, ...args) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
}

test("backfillAdded: sets added from the git commit that added each adapter file, only where missing; offline", () => {
  const repo = tmp();
  git(repo, "init", "-q");
  const dir = path.join(repo, "catalog");
  const commit = (msg, when) => {
    git(repo, "add", "-A");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", msg], { env });
  };
  writeAdapter(dir, "aaaaaaa1");
  rebuildIndex(dir);
  commit("first", "2026-11-13T12:40:05+00:00");
  writeAdapter(dir, "aaaaaaa2");
  // a later edit of the first file must not move its date (the ADD commit counts)
  fs.appendFileSync(path.join(dir, "adapters", "aaaaaaa1.json"), "\n");
  rebuildIndex(dir);
  commit("second", "2026-11-21T06:42:26+02:00");
  const idx = readIndex(dir);
  for (const e of Object.values(idx.entries)) delete e.added;
  idx.entries.aaaaaaa3 = { status: "needs-attention", server: "staging", version: "master@abc1234", gate: "x", issue: null, commit: "b".repeat(40) };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx, null, 2) + "\n");
  const r = backfillAdded(dir, { now: new Date("2026-11-26T00:00:00Z") });
  assert.deepEqual(r.set.map((s) => [s.hash, s.added]), [["aaaaaaa1", "2026-11-13T12:40:05.000Z"], ["aaaaaaa2", "2026-11-21T04:42:26.000Z"]]);
  const after = readIndex(dir);
  assert.equal(after.entries.aaaaaaa1.added, "2026-11-13T12:40:05.000Z");
  assert.equal(after.entries.aaaaaaa3.added, undefined);
  // idempotent: a second run changes nothing
  const again = backfillAdded(dir);
  assert.deepEqual(again.set, []);
  // and a rebuild keeps what the backfill wrote
  rebuildIndex(dir);
  assert.equal(readIndex(dir).entries.aaaaaaa2.added, "2026-11-21T04:42:26.000Z");
});

test("backfillAdded: an adapter file with no git history is skipped and reported, not guessed", () => {
  const dir = tmp();
  writeAdapter(dir, "aaaaaaa1");
  rebuildIndex(dir);
  const idx = readIndex(dir);
  delete idx.entries.aaaaaaa1.added;
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx));
  const r = backfillAdded(dir, { dateFor: () => null });
  assert.deepEqual(r.set, []);
  assert.equal(r.skipped[0].hash, "aaaaaaa1");
  assert.equal(readIndex(dir).entries.aaaaaaa1.added, undefined);
});
