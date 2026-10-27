// Seam: WorkAdventureClient takes `fetch` and `WebSocketImpl` so a recorder,
// or a test, can sit between the client and the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WorkAdventureClient } from "../src/wa-client.mjs";

test("connect uses the injected fetch and WebSocketImpl", async () => {
  const urls = [];
  const fetchStub = async (url) => {
    urls.push(String(url));
    const body = String(url).includes("/anonymLogin") ? { authToken: "t", userUuid: "u" } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const sockets = [];
  class StubWS extends EventEmitter {
    constructor(url, protocols) {
      super();
      this.url = url;
      this.protocols = protocols;
      sockets.push(this);
    }
    close() {}
  }
  const client = new WorkAdventureClient({
    name: "t",
    roomUrl: "https://example.test/@/o/w/r",
    pusherUrl: "https://pusher.example.test",
    nav: null,
    adapter: {
      id: "stub",
      envelope: "seq-len-v1",
      protoPath: "proto/wa-1.34/messages.proto",
      endpoints: { anonymLogin: "/anonymLogin", map: "/map" },
      apiVersionHashes: ["23c8eb8c"],
    },
    fetch: fetchStub,
    WebSocketImpl: StubWS,
  });
  client.on("error", () => {});
  client.connect().catch(() => {}); // stub never answers: don't await the join
  for (let i = 0; i < 100 && !sockets.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(sockets.length, 1, "WebSocketImpl was not used");
  assert.match(sockets[0].url, /^wss:\/\//);
  assert.deepEqual(sockets[0].protocols, ["t"]);
  assert.ok(urls.some((u) => u.endsWith("/anonymLogin")));
  assert.ok(urls.some((u) => u.includes("/map?")));
});
