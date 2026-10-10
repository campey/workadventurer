import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

test("resolveAdapter: probed v1.34.x -> wa-1.34, no warn", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    probeFn: async () => ({ kind: "release", minor: "1.34", raw: "v1.34.0" }),
  });
  assert.equal(r.adapter.id, "wa-1.34");
  assert.ok(!r.warn);
});

test("resolveAdapter: probed unknown minor -> newest released + warn", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    probeFn: async () => ({ kind: "release", minor: "1.35", raw: "v1.35.0" }),
  });
  assert.equal(r.adapter.id, "wa-1.34", "falls back to the NEWEST released adapter");
  assert.equal(r.warn, true);
  assert.match(r.why, /no wa-1\.35/);
  assert.match(r.why, /NEW_VERSION/, "must say what failure to expect, since this is how prod's v1.34 bump surfaced (#55)");
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
  assert.equal(r.adapter.id, "wa-1.34");
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

// An adapter whose hash set drifts from the proto it ships is how a version bump
// becomes a surprise (#55): the server answers NEW_VERSION and nothing here said so.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const [id, adapter] of Object.entries(ADAPTERS)) {
  test(`adapter ${id}: its vendored proto exists`, () => {
    assert.ok(fs.existsSync(path.join(root, adapter.protoPath)), `missing ${adapter.protoPath}`);
  });

  test(`adapter ${id}: its apiVersionHashes include the hash its vendored proto was computed with`, () => {
    const source = fs.readFileSync(path.join(root, path.dirname(adapter.protoPath), "SOURCE"), "utf8");
    const vendored = source.match(/^apiVersionHash: (\w+)$/m)?.[1];
    assert.ok(vendored, `no apiVersionHash line in ${path.dirname(adapter.protoPath)}/SOURCE`);
    assert.ok(
      adapter.apiVersionHashes.includes(vendored),
      `${id} sends ${adapter.apiVersionHashes[0]} but proto was vendored at ${vendored}`
    );
  });
}

test("adapters: the allowlisted prod host resolves to the newest released adapter", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    probeFn: async () => null,
  });
  const released = Object.values(ADAPTERS).filter((a) => a.stability !== "tracking");
  const newest = released.map((a) => a.id).sort().at(-1);
  assert.equal(r.adapter.id, newest, "when prod bumps, bump the allowlist with the new adapter");
});

test("only wa-1.34 reports LIVEKIT availability in a meeting area (probe meeting-availability)", async () => {
  const w133 = (await import("../src/adapters/wa-1.33.mjs")).default;
  const w134 = (await import("../src/adapters/wa-1.34.mjs")).default;
  assert.equal(w134.meeting.areaAvailabilityStatus, 11);
  assert.equal(w134.meeting.webrtcStrategyName, w133.meeting.webrtcStrategyName);
  assert.equal(w133.meeting.areaAvailabilityStatus, undefined, "the 1.33 baseline is frozen");
});
