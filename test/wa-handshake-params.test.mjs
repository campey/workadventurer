// Catalog adapters can add constant handshake query parameters (#126). The client never
// lets one override a parameter it sets itself, and refuses the identity-bearing names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkAdventureClient } from "../src/wa-client.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE = ["roomId", "characterTextureIds", "version", "roomName", "cameraState",
  "microphoneState", "screenSharingState", "chatID", "tabId"];

function client(handshake, extra = {}) {
  const adapter = { envelope: "seq-len-v1", apiVersionHashes: ["h1"], ...extra };
  if (handshake !== undefined) adapter.handshake = handshake;
  return new WorkAdventureClient({
    adapter, pusherUrl: "https://pusher.example", roomUrl: "https://play.example/_/r/map.json",
  });
}
const params = (c) => new URL(c._wsUrl()).searchParams;

test("handshake query adds new names, substitutes {tabId} and {uuid}, never overrides", () => {
  const c = client({ query: { chatID: "x", newRequired: "v", viaTab: "{tabId}", cid: "{uuid}", roomId: "evil" } });
  const p = params(c);
  assert.equal(p.get("newRequired"), "v");
  assert.equal(p.get("viaTab"), p.get("tabId"));
  assert.match(p.get("cid"), UUID);
  assert.notEqual(p.get("cid"), params(c).get("cid"));
  assert.equal(p.get("chatID"), "");
  assert.equal(p.get("roomId"), "https://play.example/_/r/map.json");
});

test("without a handshake the parameter set is exactly today's", () => {
  assert.deepEqual([...params(client()).keys()], BASE);
});

test("forbidden names are skipped case-insensitively", () => {
  const p = params(client({ query: { RoomId: "a", VERSION: "b", Token: "c", characterTextureIds2: "ok" } }));
  assert.deepEqual([...p.keys()], [...BASE, "characterTextureIds2"]);
  assert.equal(p.get("version"), "h1");
});

test("a non-string value is skipped", () => {
  const p = params(client({ query: { n: 5, o: {}, s: "ok" } }));
  assert.deepEqual([...p.keys()], [...BASE, "s"]);
});

test("a malformed handshake is treated as none", () => {
  for (const h of [null, [], "x", 7, {}, { query: null }, { query: [] }, { query: "x" }]) {
    assert.deepEqual([...params(client(h)).keys()], BASE, JSON.stringify(h));
  }
});
