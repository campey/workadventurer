import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { record, redact, save } from "../world-port/recorder.mjs";

test("record captures http out/in and ws in/out", async () => {
  class InnerWS {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.handlers = {};
      this.sent = [];
    }
    on(ev, fn) { (this.handlers[ev] ??= []).push(fn); return this; }
    send(data) { this.sent.push(data); }
    close() {}
  }
  const innerFetch = async () => ({
    ok: true, status: 200,
    clone() { return this; },
    async arrayBuffer() { return new TextEncoder().encode('{"a":1}').buffer; },
    async json() { return { a: 1 }; },
  });
  const sink = [];
  const { fetch, WebSocketImpl } = record({ fetch: innerFetch, WebSocketImpl: InnerWS }, sink);
  const res = await fetch("https://p.test/anonymLogin", { method: "POST", body: "{}" });
  assert.deepEqual(await res.json(), { a: 1 });
  const ws = new WebSocketImpl("wss://p.test/ws/room", ["tok"]);
  const got = [];
  ws.on("message", (d) => got.push(d));
  ws.send(Buffer.from([1, 2, 3]));
  ws.handlers.message[0](Buffer.from([9, 8]));
  assert.equal(got.length, 1, "listener still receives the frame");

  const by = (port, dir) => sink.filter((e) => e.port === port && e.dir === dir);
  assert.equal(by("http", "out")[0].url, "https://p.test/anonymLogin");
  assert.equal(by("http", "in")[0].status, 200);
  assert.equal(Buffer.from(by("http", "in")[0].bytes, "base64").toString(), '{"a":1}');
  assert.equal(by("ws", "out").find((e) => e.bytes).bytes, Buffer.from([1, 2, 3]).toString("base64"));
  assert.equal(by("ws", "in")[0].bytes, Buffer.from([9, 8]).toString("base64"));
  assert.ok(sink.every((e) => typeof e.t === "number"));
});

test("redact blanks authToken, JWTs, uuids, names and chat text", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig_nature-1";
  const entries = [
    { t: 0, port: "http", dir: "in", status: 200, bytes: Buffer.from(`{"authToken":"t0k3n"}`).toString("base64") },
    { t: 1, port: "ws", dir: "out", url: `wss://p.test/ws/room?token=${jwt}`, bytes: "AAAA" },
    { t: 2, port: "ws", dir: "in", url: "x/6f1c2a3e-1111-2222-3333-444455556666", bytes: "AAAA",
      decoded: { userJoinedMessage: { name: "Ana", userUuid: "6f1c2a3e-1111-2222-3333-444455556666" },
                 publicEvent: { spaceEvent: { spaceMessage: { message: "hello there", name: "Ana" } } } } },
  ];
  const out = JSON.stringify(redact(entries));
  for (const s of ["t0k3n", "eyJhbGciOi", "6f1c2a3e-1111-2222-3333-444455556666", "Ana", "hello there"]) {
    assert.ok(!out.includes(s), `leaked ${s}`);
  }
  assert.ok(out.includes("<redacted>"));
  assert.equal(entries[2].decoded.userJoinedMessage.name, "Ana", "input not mutated");
});

test("save writes jsonl under world-port/recordings", () => {
  const p = save([{ t: 0, port: "ws", dir: "in" }], "unit-test");
  try {
    assert.match(p, /world-port\/recordings\/unit-test-.*\.jsonl$/);
    assert.deepEqual(JSON.parse(readFileSync(p, "utf8").trim()), { t: 0, port: "ws", dir: "in" });
  } finally { rmSync(p, { force: true }); }
});

test("redact drops real recorded ws frames (names/chat inside protobuf bytes)", () => {
  class InnerWS {
    constructor() { this.h = {}; }
    on(ev, fn) { this.h[ev] = fn; return this; }
    send() {}
  }
  const sink = [];
  const { WebSocketImpl } = record({ fetch: async () => ({}), WebSocketImpl: InnerWS }, sink);
  const ws = new WebSocketImpl("wss://p.test/ws/room");
  let frame = Buffer.concat([Buffer.from([10, 3]), Buffer.from("Ana"), Buffer.from([18, 11]), Buffer.from("hello there")]);
  ws.on("message", () => {});
  ws.h.message(frame);
  const out = JSON.stringify(redact(sink));
  for (const s of ["Ana", "hello there", Buffer.from("Ana").toString("base64"), Buffer.from("hello there").toString("base64"), frame.toString("base64")]) {
    assert.ok(!out.includes(s), `leaked ${s}`);
  }
  assert.ok(out.includes(`"length":${frame.length}`));
});

test("redact ignores 1-2 character names when collecting secrets", () => {
  const e = [{ t: 0, port: "http", dir: "in", url: "https://p.test/map?x=abc", decoded: { name: "a" } }];
  assert.equal(redact(e)[0].url, "https://p.test/map?x=abc");
});
