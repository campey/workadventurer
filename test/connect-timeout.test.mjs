// #138: an overnight soak lost an hour to one reconnect attempt that hung —
// anonymLogin and the socket join had no timeout, so the reconnect chain never
// got to its next attempt. A hung attempt must fail fast instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { WorkAdventureClient } from "../src/wa-client.mjs";

async function silentServer({ answerLogin }) {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url.startsWith("/anonymLogin")) {
      if (!answerLogin) return; // never respond
      return res.end(JSON.stringify({ authToken: "t", userUuid: "u" }));
    }
    res.end("{}");
  });
  // Accept the socket, then say nothing: no roomConnectedMessage, no join.
  const wss = new WebSocketServer({ server, path: "/ws/room", handleProtocols: (p) => [...p][0] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    roomUrl: `http://127.0.0.1:${port}/@/a/b/c`,
    close: () => new Promise((r) => { wss.close(); server.closeAllConnections?.(); server.close(r); }),
  };
}

const clientFor = (s) =>
  new WorkAdventureClient({
    name: "t", roomUrl: s.roomUrl, pusherUrl: s.url, target: "wa-1.34", connectTimeoutMs: 300,
  });

test("connect() fails fast when anonymLogin never answers", async () => {
  const s = await silentServer({ answerLogin: false });
  const c = clientFor(s);
  const t0 = Date.now();
  try {
    await assert.rejects(c.connect());
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  } finally {
    try { c.close(); } catch {}
    await s.close();
  }
});

test("connect() fails fast when the socket opens but the server never joins us", async () => {
  const s = await silentServer({ answerLogin: true });
  const c = clientFor(s);
  const t0 = Date.now();
  try {
    await assert.rejects(c.connect(), /timed out|closed before join/);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  } finally {
    try { c.close(); } catch {}
    await s.close();
  }
});
