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

async function startCatalog({ entries = true } = {}) {
  const sha256 = createHash("sha256").update(adapterText).digest("hex");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/catalog/index.json") {
      return res.end(JSON.stringify({
        schema: 1, updated: "x",
        entries: !entries ? {} : { [NEW_HASH]: { status: "ok", server: "production", version: "9.9", file: `adapters/${NEW_HASH}.json`, sha256 } },
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

async function withSetup(mode, body, { entries = true, env = {}, pusherOpts = { acceptHashes: [NEW_HASH] } } = {}) {
  const pusher = await startFakePusher(pusherOpts);
  const catalog = await startCatalog({ entries });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-daemon-recovery-"));
  const port = await freePort();
  const child = spawn(process.execPath, [DAEMON], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, NODE_USE_ENV_PROXY: "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
      WA_ROOM: pusher.roomUrl, WA_PUSHER_URL: pusher.url, WA_CATALOG_URL: catalog.url,
      WA_ADAPTER_UPDATES: mode, WA_DAEMON_PORT: String(port), WA_VERSION: "", WA_TARGET: "auto", ...env,
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

// A timeout that is cleared once the race is decided (a dangling 15 s timer would hold the test process open).
function raceTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((r) => { t = setTimeout(() => r("timeout"), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
}

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
    const code = await raceTimeout(exited, 15000);
    assert.equal(code, REFUSED_EXIT, output());
    assert.equal(fs.existsSync(path.join(home, ".workadventurer", "adapters")), false);
    assert.match(output(), /run `wa join` again to check the catalog for an adapter, or set WA_ADAPTER_UPDATES=auto/);
  });
});

test("auto: a catalog with no entry for the hash logs why and exits REFUSED_EXIT", async () => {
  await withSetup("auto", async ({ exited, output }) => {
    const code = await raceTimeout(exited, 15000);
    assert.equal(code, REFUSED_EXIT, output());
    assert.match(output(), /no adapter for this server version yet/);
  }, { entries: false });
});

test("auto with an adapter file: a refused candidate is not replaced from the catalog; exits REFUSED_EXIT", async () => {
  const file = path.join(os.tmpdir(), `wa-cand-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schema: 1, id: "cand", waVersion: "9.8", apiVersionHash: "f11e0001", server: "production", protoFamily: "wa-1.34",
  }));
  try {
    await withSetup("auto", async ({ pusher, home, exited, output }) => {
      const code = await raceTimeout(exited, 15000);
      assert.equal(code, REFUSED_EXIT, output());
      assert.match(output(), /refused the candidate adapter file/);
      assert.equal(fs.existsSync(path.join(home, ".workadventurer", "adapters")), false);
      assert.deepEqual([...new Set(pusher.stats.versions)], ["f11e0001"], "never retried with another hash");
    }, { env: { WA_ADAPTER_FILE: file } });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// --- #186: the reconnect path and the second refusal ---

const BUILTIN = "f4cfe455";
const OTHER = "feedbeef"; // a hash the server takes but the catalog knows nothing about
const daemonState = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/state`)).ok; } catch { return false; } };

test("auto, reconnect: the server upgrades while we are up -> recover once, reconnect with the catalog adapter", async () => {
  await withSetup("auto", async ({ pusher, home, port, output }) => {
    const rejoined = await until(() => (pusher.stats.versions.includes(NEW_HASH) && pusher.stats.joins >= 2) || pusher.stats.versions.at(-1) === NEW_HASH);
    assert.ok(rejoined, `never reconnected with the catalog adapter:\n${output()}`);
    assert.ok(await until(() => daemonState(port)), output());
    assert.deepEqual(pusher.stats.versions.slice(0, 2), [BUILTIN, BUILTIN]);
    assert.equal(pusher.stats.versions.at(-1), NEW_HASH);
    assert.ok(fs.existsSync(path.join(home, ".workadventurer", "adapters", `${NEW_HASH}.json`)));
  }, { pusherOpts: { acceptHashes: [BUILTIN], joinFirstMs: 300, afterFirstJoin: { acceptHashes: [NEW_HASH] } } });
});

test("auto, reconnect: no catalog entry -> the daemon gives up and exits REFUSED_EXIT", async () => {
  await withSetup("auto", async ({ pusher, exited, output }) => {
    const code = await raceTimeout(exited, 20000);
    assert.equal(code, REFUSED_EXIT, output());
    assert.match(output(), /reconnect gave up/);
    assert.match(output(), /no adapter for this server version yet/);
    assert.equal(pusher.stats.versions[0], BUILTIN);
  }, { entries: false, pusherOpts: { acceptHashes: [BUILTIN], joinFirstMs: 300, afterFirstJoin: { acceptHashes: [NEW_HASH] } } });
});

test("auto, initial connect: the catalog adapter is also rejected -> one retry, then REFUSED_EXIT", async () => {
  await withSetup("auto", async ({ pusher, exited, output }) => {
    const code = await raceTimeout(exited, 15000);
    assert.equal(code, REFUSED_EXIT, output());
    assert.deepEqual(pusher.stats.versions, [BUILTIN, NEW_HASH], "one recovery per refusal, never a second");
    assert.match(output(), /not retrying/);
  }, { pusherOpts: { acceptHashes: [OTHER], pageHash: NEW_HASH } });
});

test("auto, reconnect: the catalog adapter is also rejected -> one retry, then REFUSED_EXIT", async () => {
  await withSetup("auto", async ({ pusher, exited, output }) => {
    const code = await raceTimeout(exited, 20000);
    assert.equal(code, REFUSED_EXIT, output());
    assert.equal(pusher.stats.versions.filter((v) => v === NEW_HASH).length, 1, "the recovered adapter is tried once");
    assert.equal(pusher.stats.versions.at(-1), NEW_HASH);
    assert.match(output(), /reconnect gave up/);
  }, { pusherOpts: { acceptHashes: [BUILTIN], joinFirstMs: 300, afterFirstJoin: { acceptHashes: [OTHER], pageHash: NEW_HASH } } });
});

test("auto: an unreachable catalog logs the sanitised reason, not just 'unavailable'", async () => {
  await withSetup("auto", async ({ exited, output }) => {
    const code = await raceTimeout(exited, 15000);
    assert.equal(code, 4, output());
    assert.match(output(), /adapter recovery: unavailable \(index: [^)\n]+\)/);
  }, { env: { WA_CATALOG_URL: "http://127.0.0.1:1/catalog/index.json" } });
});

// --- WA_PROBED_HASH plumbing (#185): wa join's pre-flight hash -> env -> daemon -> client hint ---

test("WA_PROBED_HASH: with the home page unreadable the daemon joins using the hint (a non-first built-in hash)", async () => {
  await withSetup("ask", async ({ pusher, port, output }) => {
    assert.ok(await until(() => daemonState(port)), `daemon never came up:\n${output()}`);
    assert.deepEqual(pusher.stats.versions, ["62e25483"]);
  }, { env: { WA_PROBED_HASH: "62e25483" }, pusherOpts: { acceptHashes: ["62e25483"], pageBroken: true } });
});

test("WA_PROBED_HASH: a malformed value is ignored (the daemon falls back and is refused)", async () => {
  for (const bad of ["62e2548", "62E25483", "zzzzzzzz", "62e25483; rm"]) {
    await withSetup("ask", async ({ pusher, exited, output }) => {
      const code = await raceTimeout(exited, 15000);
      assert.equal(code, REFUSED_EXIT, output());
      assert.ok(!pusher.stats.versions.includes("62e25483"), `${bad} was used: ${pusher.stats.versions}`);
    }, { env: { WA_PROBED_HASH: bad }, pusherOpts: { acceptHashes: ["62e25483"], pageBroken: true } });
  }
});
