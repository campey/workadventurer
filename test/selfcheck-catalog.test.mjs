// scripts/selfcheck.mjs runs the same catalog pre-flight as `wa join`, so
// `selfcheck --target production` works on a server newer than the built-ins.
// Fake pusher (accepts only the new hash) plus a local catalog, temp HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { REFUSED_EXIT } from "../src/supervise.mjs";
import { startFakePusher } from "./helpers/fake-pusher.mjs";

const SELFCHECK = fileURLToPath(new URL("../scripts/selfcheck.mjs", import.meta.url));
const NEW_HASH = "5ec0de01";
const adapterText = JSON.stringify({ schema: 1, id: "wa-test", waVersion: "9.9", apiVersionHash: NEW_HASH, server: "production", protoFamily: "wa-1.34" });

async function run(mode, extraArgs = [], { env = {} } = {}) {
  const pusher = await startFakePusher({ acceptHashes: [NEW_HASH] });
  const sha256 = createHash("sha256").update(adapterText).digest("hex");
  const catalog = http.createServer((req, res) => {
    if (req.url === "/catalog/index.json") return res.end(JSON.stringify({ schema: 1, updated: "x", entries: { [NEW_HASH]: { status: "ok", server: "production", version: "9.9", file: `adapters/${NEW_HASH}.json`, sha256 } } }));
    if (req.url === `/catalog/adapters/${NEW_HASH}.json`) return res.end(adapterText);
    res.statusCode = 404; res.end("nope");
  });
  await new Promise((r) => catalog.listen(0, "127.0.0.1", r));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-selfcheck-"));
  const child = spawn(process.execPath, ["--no-warnings", SELFCHECK, ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, NODE_USE_ENV_PROXY: "", HTTPS_PROXY: "", https_proxy: "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
      WA_ROOM: pusher.roomUrl, WA_PUSHER_URL: pusher.url, WA_CATALOG_URL: `http://127.0.0.1:${catalog.address().port}/catalog/index.json`,
      WA_ADAPTER_UPDATES: mode, WA_VERSION: "", WA_TARGET: "auto", ...env,
    },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 40000);
  const code = await new Promise((r) => child.on("exit", r));
  clearTimeout(timer);
  const cached = fs.existsSync(path.join(home, ".workadventurer", "adapters", `${NEW_HASH}.json`));
  const versions = pusher.stats.versions.slice();
  catalog.closeAllConnections?.(); catalog.close();
  await pusher.close();
  fs.rmSync(home, { recursive: true, force: true });
  return { code, out, cached, versions };
}

test("auto: the catalog adapter is applied and cached, and the hash is accepted", async () => {
  const r = await run("auto", ["--target", "production"]);
  assert.match(r.out, /PASS\s+adapter resolved\s+— wa-test/, r.out);
  assert.match(r.out, /PASS\s+apiVersionHash accepted/, r.out);
  assert.equal(r.cached, true);
  assert.deepEqual(r.versions, [NEW_HASH]);
});

test("ask with no terminal: answers no, prints how to allow it, exits REFUSED_EXIT, caches nothing", async () => {
  const r = await run("ask", ["--target", "production"]);
  assert.equal(r.code, REFUSED_EXIT, r.out);
  assert.match(r.out, /WA_ADAPTER_UPDATES=auto/);
  assert.equal(r.cached, false);
  assert.deepEqual(r.versions, []);
});

test("an explicit non-auto target skips the pre-flight (nothing fetched or cached)", async () => {
  const r = await run("auto", ["--target", "wa-1.34"]);
  assert.equal(r.cached, false);
});
