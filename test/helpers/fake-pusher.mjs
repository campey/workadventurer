// Minimal fake pusher for reconnect / error-screen tests (issue #56).
// POST /anonymLogin, GET /map, WS /ws/room -> one errorScreenMessage frame,
// then close 1000. No production traffic.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import { WebSocketServer } from "ws";
import { WorkAdventureClient } from "../../src/wa-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startFakePusher({
  code = "NEW_VERSION",
  type = "retry",
  title = "Please refresh",
  details = "A new version of WorkAdventure is available",
  timeToRetry = 999999,
  listenPort = 0,
  joinFirstMs = 0, // >0: the first connection joins, then is dropped after this many ms
  proto = "proto/wa-1.34/messages.proto",
  acceptHashes = null, // given: reject (errorScreen) any /ws/room whose `version` query isn't listed; GET / serves a home page carrying the first one
  pageHash = null, // with acceptHashes: the hash the home page advertises instead of acceptHashes[0] (a server that announces one hash and takes another)
  pageBroken = false, // with acceptHashes: GET / answers 500 (the home page cannot be read)
  afterFirstJoin = null, // with acceptHashes: { acceptHashes, pageHash? } swapped in once the first client has joined; joinFirstMs then drops that socket (the server "upgrades" while we are up)
} = {}) {
  const root = await protobuf.load(path.join(__dirname, "..", "..", proto));
  const S2C = root.lookupType("ServerToClientMessage");
  const framer = new WorkAdventureClient({ adapter: { envelope: "seq-len-v1" } });
  const frame = () =>
    framer._wrap(
      S2C.encode(
        S2C.fromObject({
          errorScreenMessage: {
            type,
            code: { value: code },
            title: { value: title },
            details: { value: details },
            timeToRetry: { value: timeToRetry },
            canRetryManual: { value: true },
          },
        })
      ).finish()
    );

  const joinedFrame = () =>
    framer._wrap(S2C.encode(S2C.fromObject({ roomJoinedMessage: { currentUserId: 1 } })).finish());

  const stats = { logins: 0, connections: 0, versions: [], joins: 0 };
  const accept = { hashes: acceptHashes, pageHash };
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url.startsWith("/anonymLogin")) {
      stats.logins++;
      return res.end(JSON.stringify({ authToken: "fake-token", userUuid: "fake-uuid" }));
    }
    if (acceptHashes && req.method === "GET" && req.url === "/") {
      if (pageBroken) { res.statusCode = 500; return res.end("down"); }
      res.setHeader("content-type", "text/html");
      return res.end(`<html><head><meta name="wa-api-version" content="${accept.pageHash ?? accept.hashes[0]}"></head><body>v9.9.9</body></html>`);
    }
    res.end("{}");
  });
  const wss = new WebSocketServer({ server, path: "/ws/room", handleProtocols: (p) => [...p][0] });
  wss.on("connection", (ws, req) => {
    stats.connections++;
    if (acceptHashes) {
      const v = new URL(req.url, "http://x").searchParams.get("version");
      stats.versions.push(v);
      if (accept.hashes.includes(v)) {
        ws.send(joinedFrame());
        if (afterFirstJoin && stats.joins++ === 0) {
          accept.hashes = afterFirstJoin.acceptHashes;
          accept.pageHash = afterFirstJoin.pageHash ?? null;
          if (joinFirstMs > 0) setTimeout(() => ws.terminate(), joinFirstMs);
        }
        return;
      }
      ws.send(frame());
      setTimeout(() => ws.close(1000, "Error message sent"), 20);
      return;
    }
    if (stats.connections === 1 && joinFirstMs > 0) {
      // Let the first client join, then drop it: later connections get the
      // error screen, so the daemon sits in reconnect retry waits (#59 check).
      ws.send(joinedFrame());
      setTimeout(() => ws.terminate(), joinFirstMs);
      return;
    }
    ws.send(frame());
    setTimeout(() => ws.close(1000, "Error message sent"), 20);
  });
  await new Promise((r) => server.listen(listenPort, "127.0.0.1", r));
  const port = server.address().port;
  return {
    stats,
    port,
    url: `http://127.0.0.1:${port}`,
    roomUrl: `http://127.0.0.1:${port}/@/a/b/c`,
    close: () => new Promise((r) => { wss.close(); server.closeAllConnections?.(); server.close(r); }),
  };
}
