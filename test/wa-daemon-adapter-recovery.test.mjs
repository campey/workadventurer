// #126: in `auto` mode the daemon fetches the catalog adapter by itself after a
// NEW_VERSION refusal and retries once; in `ask` mode it exits REFUSED_EXIT and
// touches nothing. Real daemon child process against the fake pusher plus a
// local catalog, with a temp HOME so the cache never reaches the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { REFUSED_EXIT } from "../src/supervise.mjs";
import { startFakePusher } from "./helpers/fake-pusher.mjs";

const DAEMON = fileURLToPath(new URL("../src/wa-daemon.mjs", import.meta.url));
const NEW_HASH = "5ec0de01";

const adapterText = JSON.stringify({
  schema: 1, id: "wa-test", waVersion: "9.9", apiVersionHash: NEW_HASH, server: "production", protoFamily: "wa-1.34",
});

async function startCatalog() {
  const sha256 = createHash("sha256").update(adapterText).digest("hex");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/catalog/index.json") {
      return res.end(JSON.stringify({
        schema: 1, updated: "x",
        entries: { [NEW_HASH]: { status: "ok", server: "production", version: "9.9", file: `adapters/${NEW_HASH}.json`, sha256 } },
      }));
    }
    if (req.url === `/catalog/adapters/${NEW_HASH}.json`) return res.end(adapterText);
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/catalog/index.json`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

async function withSetup(mode, body) {
  const pusher = await startFakePusher({ acceptHashes: [NEW_HASH] });
  const catalog = await startCatalog();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-daemon-recovery-"));
  const port = await freePort();
  const child = spawn(process.execPath, [DAEMON], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, NODE_USE_ENV_PROXY: "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
      WA_ROOM: pusher.roomUrl, WA_PUSHER_URL: pusher.url, WA_CATALOG_URL: catalog.url,
      WA_ADAPTER_UPDATES: mode, WA_DAEMON_PORT: String(port), WA_VERSION: "", WA_TARGET: "auto",
    },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.on("exit", r));
  try {
    await body({ pusher, home, port, child, exited, output: () => out });
  } finally {
    child.kill("SIGKILL");
    await exited;
    await pusher.close();
    await catalog.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const until = async (cond, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test("auto: a NEW_VERSION refusal fetches the catalog adapter and the daemon joins", async () => {
  await withSetup("auto", async ({ pusher, home, port, output }) => {
    const up = await until(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/state`)).ok; } catch { return false; }
    });
    assert.ok(up, `daemon never came up:\n${output()}`);
    assert.equal(pusher.stats.versions.at(-1), NEW_HASH);
    assert.ok(pusher.stats.versions.length >= 2, "first attempt should have been refused");
    assert.ok(fs.existsSync(path.join(home, ".workadventurer", "adapters", `${NEW_HASH}.json`)));
  });
});

test("ask: the daemon cannot prompt, exits REFUSED_EXIT and writes no cache", async () => {
  await withSetup("ask", async ({ home, exited, output }) => {
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15000))]);
    assert.equal(code, REFUSED_EXIT, output());
    assert.equal(fs.existsSync(path.join(home, ".workadventurer", "adapters")), false);
  });
});
