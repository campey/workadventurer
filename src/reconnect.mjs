// Reconnect with exactly one chain in flight (issue #56).
//
// The daemon used to wire every attempt client with the reconnect-on-close
// handler; a server that rejects an attempt closes the socket, which started
// another chain, so attempts grew ~2^N (1187 connections in 100s against a
// fake pusher). start() is idempotent while a chain runs, so a stray `close`
// from an attempt client or a stale client can never fork a second one.

import { ServerRejectedError } from "./server-rejected.mjs";

// The schedule's last value repeats forever: a network outage can outlast any
// fixed number of attempts, and giving up kills the session (soak 2026-10-08,
// #138). Only a deliberate shutdown or a fatal server rejection ends the chain.
export const DEFAULT_DELAYS = [2000, 5000, 10000, 20000, 30000, 60000];

const fmtDown = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

// `fetch failed` says nothing; the reason is on e.cause (ENOTFOUND, ETIMEDOUT…).
const describe = (e) => {
  const code = e.cause?.code ?? e.cause?.message;
  return code ? `${e.message} (${code})` : e.message;
};

export function createReconnector({
  makeClient, // () => unconnected client
  onConnected, // (client) => void — adopt the connected client
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  log = () => {},
  delays = DEFAULT_DELAYS,
  maxAttempts = Infinity,
  isStopped = () => false,
}) {
  let running = null;

  async function chain() {
    const downSince = now();
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(delays[Math.min(i, delays.length - 1)]);
      if (isStopped()) throw new Error("shut down during reconnect");
      const of = Number.isFinite(maxAttempts) ? `/${maxAttempts}` : "";
      log(`reconnect attempt ${i + 1}${of} (down ${fmtDown(now() - downSince)})…`);
      const client = makeClient();
      try {
        await client.connect();
        onConnected(client);
        return client;
      } catch (e) {
        log(`  attempt ${i + 1} failed: ${describe(e)}`);
        try { client.close(); } catch {}
        if (e instanceof ServerRejectedError && !e.retryable) throw e;
      }
    }
    throw new Error("exhausted reconnect attempts");
  }

  return {
    start() {
      if (!running) running = chain().finally(() => { running = null; });
      return running;
    },
    get active() { return running !== null; },
  };
}
