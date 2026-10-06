// Bounded reconnect with exactly one chain in flight (issue #56).
//
// The daemon used to wire every attempt client with the reconnect-on-close
// handler; a server that rejects an attempt closes the socket, which started
// another chain, so attempts grew ~2^N (1187 connections in 100s against a
// fake pusher). start() is idempotent while a chain runs, so a stray `close`
// from an attempt client or a stale client can never fork a second one.

import { ServerRejectedError } from "./server-rejected.mjs";

export const DEFAULT_DELAYS = [2000, 5000, 10000, 20000, 30000];

export function createReconnector({
  makeClient, // () => unconnected client
  onConnected, // (client) => void — adopt the connected client
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
  delays = DEFAULT_DELAYS,
  isStopped = () => false,
}) {
  let running = null;

  async function chain() {
    for (let i = 0; i < delays.length; i++) {
      await sleep(delays[i]);
      if (isStopped()) throw new Error("shut down during reconnect");
      log(`reconnect attempt ${i + 1}/${delays.length}…`);
      const client = makeClient();
      try {
        await client.connect();
        onConnected(client);
        return client;
      } catch (e) {
        log(`  attempt ${i + 1} failed: ${e.message}`);
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
