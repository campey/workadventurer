// #138: at 04:50 in the overnight soak the server closed us with "did not send
// a pong in time" while our side still believed the socket was healthy — the
// only outbound traffic we had was position re-broadcasts, and nothing checked
// that anything came back. The heartbeat pings at the transport level and
// terminates a socket that has gone silent, so the reconnect chain takes over.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import { WorkAdventureClient } from "../src/wa-client.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup({ autoPong }) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong });
  await new Promise((r) => wss.on("listening", r));
  const client = new WorkAdventureClient({
    name: "t", roomUrl: "http://x/@/a/b/c", pusherUrl: "http://x", target: "wa-1.34",
    heartbeatIntervalMs: 50, deadAfterMs: 300,
  });
  const logs = [];
  client.on("log", (m) => logs.push(m));
  client.ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  await new Promise((r) => client.ws.on("open", r));
  client._startHeartbeat();
  const done = async () => {
    client._stopHeartbeat();
    client.ws.terminate();
    await new Promise((r) => wss.close(r));
  };
  return { client, logs, done };
}

test("a socket that answers pings is left alone well past deadAfterMs", async () => {
  const { client, done } = await setup({ autoPong: true });
  try {
    await sleep(900); // 3x deadAfterMs
    assert.equal(client.ws.readyState, WebSocket.OPEN);
  } finally {
    await done();
  }
});

test("a silent socket (no pongs, no traffic) is terminated after deadAfterMs", async () => {
  const { client, logs, done } = await setup({ autoPong: false });
  try {
    const t0 = Date.now();
    await new Promise((r) => client.ws.on("close", r));
    const took = Date.now() - t0;
    assert.ok(took >= 250 && took < 1500, `terminated after ${took}ms`);
    assert.ok(logs.some((l) => /no traffic for/.test(l)), logs.join("\n"));
  } finally {
    await done();
  }
});

test("inbound application traffic counts as liveness even with no pongs", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong: false });
  await new Promise((r) => wss.on("listening", r));
  // The server chatters every 100ms but never pongs.
  wss.on("connection", (s) => {
    const t = setInterval(() => s.readyState === 1 && s.send("x"), 100);
    s.on("close", () => clearInterval(t));
  });
  const client = new WorkAdventureClient({
    name: "t", roomUrl: "http://x/@/a/b/c", pusherUrl: "http://x", target: "wa-1.34",
    heartbeatIntervalMs: 50, deadAfterMs: 300,
  });
  client.ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  await new Promise((r) => client.ws.on("open", r));
  client._startHeartbeat();
  try {
    await sleep(900);
    assert.equal(client.ws.readyState, WebSocket.OPEN);
  } finally {
    client._stopHeartbeat();
    client.ws.terminate();
    await new Promise((r) => wss.close(r));
  }
});

test("a long gap between heartbeat ticks is logged as a stall / sleep", async () => {
  const { client, logs, done } = await setup({ autoPong: true });
  try {
    // Simulate the process being suspended: pretend the last tick was long ago.
    client._hbLastTick = Date.now() - 5000;
    await sleep(120);
    assert.ok(logs.some((l) => /stalled|slept/.test(l)), logs.join("\n"));
  } finally {
    await done();
  }
});
