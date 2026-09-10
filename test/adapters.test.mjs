import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTERS,
  matchVersion,
  resolveAdapter,
} from "../src/adapters/index.mjs";

test("matchVersion picks a release minor from landing-page HTML", () => {
  assert.deepEqual(matchVersion('<meta>build v1.33.5</meta>'), {
    kind: "release",
    minor: "1.33",
    raw: "v1.33.5",
  });
});

test("matchVersion picks a master sha", () => {
  const m = matchVersion("<span>master@7d628838d9449e41684dda32</span>");
  assert.equal(m.kind, "master");
  assert.equal(m.sha, "7d628838d9449e41684dda32");
});

test("matchVersion returns null when nothing matches", () => {
  assert.equal(matchVersion("<html>nothing here</html>"), null);
});

test("resolveAdapter: explicit override wins and skips the probe", async () => {
  let probed = false;
  const r = await resolveAdapter({
    roomUrl: "https://example.com/@/x/y/z",
    override: "wa-master",
    probeFn: async () => ((probed = true), null),
  });
  assert.equal(r.adapter.id, "wa-master");
  assert.equal(probed, false);
  assert.match(r.why, /explicit/);
});

test("resolveAdapter: unknown override throws with the known list", async () => {
  await assert.rejects(
    () => resolveAdapter({ override: "wa-9.9" }),
    /unknown .*wa-9\.9.*wa-1\.33/s
  );
});

test("resolveAdapter: probed v1.33.x -> wa-1.33", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    probeFn: async () => ({ kind: "release", minor: "1.33", raw: "v1.33.5" }),
  });
  assert.equal(r.adapter.id, "wa-1.33");
  assert.ok(!r.warn);
});

test("resolveAdapter: probed unknown minor -> newest released + warn", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    probeFn: async () => ({ kind: "release", minor: "1.34", raw: "v1.34.0" }),
  });
  assert.equal(r.adapter.id, "wa-1.33");
  assert.equal(r.warn, true);
  assert.match(r.why, /no wa-1\.34/);
});

test("resolveAdapter: probed master, sha matches tracked -> no warn", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.staging.workadventu.re/@/a/b/c",
    probeFn: async () => ({ kind: "master", sha: "7d628838", raw: "master@7d628838" }),
  });
  assert.equal(r.adapter.id, "wa-master");
  assert.ok(!r.warn);
});

test("resolveAdapter: probed master, sha drifted -> warn names both shas", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.staging.workadventu.re/@/a/b/c",
    probeFn: async () => ({ kind: "master", sha: "abc1234", raw: "master@abc1234" }),
  });
  assert.equal(r.adapter.id, "wa-master");
  assert.equal(r.warn, true);
  assert.match(r.why, /abc1234/);
  assert.match(r.why, /7d628838/);
});

test("resolveAdapter: probe fails, known host -> allowlist", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    probeFn: async () => null,
  });
  assert.equal(r.adapter.id, "wa-1.33");
  assert.match(r.why, /allowlist/);
});

test("resolveAdapter: probe fails, unknown host -> warned default", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.example.org/@/a/b/c",
    probeFn: async () => null,
  });
  assert.equal(r.adapter.id, "wa-1.33");
  assert.equal(r.warn, true);
  assert.match(r.why, /default/);
});
