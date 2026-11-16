import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { matchApiHash, readServerVersion } from "../src/catalog/server-version.mjs";
import { matchVersion } from "../src/adapters/index.mjs";

const TAG = '<meta name="wa-api-version" content="f4cfe455">';

test("matchApiHash reads the real tag", () => {
  assert.equal(matchApiHash(`<head>${TAG}</head>`), "f4cfe455");
});
test("matchApiHash accepts reversed attribute order and single quotes", () => {
  assert.equal(matchApiHash('<meta content="f4cfe455" name="wa-api-version">'), "f4cfe455");
  assert.equal(matchApiHash("<meta name='wa-api-version' content='f4cfe455'/>"), "f4cfe455");
});
test("matchApiHash rejects non-hex, wrong length and missing tag", () => {
  assert.equal(matchApiHash('<meta name="wa-api-version" content="zzzzzzzz">'), null);
  assert.equal(matchApiHash('<meta name="wa-api-version" content="f4cfe4555">'), null);
  assert.equal(matchApiHash("<html>v1.34.4</html>"), null);
});

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, "127.0.0.1", () => {
      resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/room/x` });
    });
  });
}

test("readServerVersion returns hash and release", async () => {
  const { srv, url } = await serve((q, r) => r.end(`<html>${TAG} v1.34.4</html>`));
  try {
    assert.deepEqual(await readServerVersion(url, { matchRelease: matchVersion }), {
      hash: "f4cfe455",
      release: "v1.34.4",
    });
  } finally { srv.close(); }
});
test("readServerVersion without the tag gives hash null", async () => {
  const { srv, url } = await serve((q, r) => r.end("<html>master@10b19f83abc</html>"));
  try {
    assert.deepEqual(await readServerVersion(url, { matchRelease: matchVersion }), {
      hash: null,
      release: "master@10b19f83abc",
    });
  } finally { srv.close(); }
});
test("readServerVersion is null on 500 and when nothing is found", async () => {
  const a = await serve((q, r) => { r.statusCode = 500; r.end(TAG); });
  const b = await serve((q, r) => r.end("<html></html>"));
  try {
    assert.equal(await readServerVersion(a.url, { matchRelease: matchVersion }), null);
    assert.equal(await readServerVersion(b.url, { matchRelease: matchVersion }), null);
  } finally { a.srv.close(); b.srv.close(); }
});
test("readServerVersion times out on a silent server", async () => {
  const { srv, url } = await serve(() => {});
  const t0 = Date.now();
  try {
    assert.equal(await readServerVersion(url, { timeoutMs: 100 }), null);
    assert.ok(Date.now() - t0 < 1000);
  } finally { srv.closeAllConnections(); srv.close(); }
});
