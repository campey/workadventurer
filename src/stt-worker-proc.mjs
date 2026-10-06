// Lifecycle of the resident STT worker process (issue #57).
//
// The worker is spawned with a piped stdin that we never write to and keep
// open for as long as we live. Its contract (scripts/stt_worker.py): exit when
// that pipe hits EOF. The OS closes our end when this process dies — however
// it dies, including SIGKILL — so the worker can't outlive its daemon.
// stop() is the graceful path (SIGTERM, escalating to SIGKILL).

import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";

const STOP_GRACE_MS = 3000;

export function createWorkerManager({ command, args, sockPath, startupTimeoutMs = 30000 }) {
  let proc = null;
  let ready = null; // resolves once the worker reports it is listening

  function ensure(log = () => {}) {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      // Our own socket path only (it embeds our pid) — never another daemon's.
      try { unlinkSync(sockPath); } catch {}
      const p = spawn(command, args(sockPath), { stdio: ["pipe", "ignore", "pipe"] });
      proc = p;
      p.stdin.on("error", () => {}); // EPIPE if the worker is already gone
      let settled = false;
      p.stderr.on("data", (c) => {
        const line = c.toString().trim();
        if (line) log(`stt-worker: ${line}`);
        if (!settled && /listening on/.test(line)) { settled = true; resolve(); }
      });
      p.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
      p.on("exit", (code) => {
        log(`stt-worker exited (${code})`);
        // A stale process's exit must not reset state belonging to a newer one.
        if (proc === p) { proc = null; ready = null; }
        if (!settled) { settled = true; reject(new Error(`stt-worker exited ${code} before starting`)); }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("stt-worker startup timeout"));
          // Don't leave a slow-but-alive process unaccounted for; the exit
          // handler resets state so the next ensure() retries cleanly.
          try { p.kill(); } catch {}
        }
      }, startupTimeoutMs).unref();
    });
    return ready;
  }

  /** Stop the worker (if any) and resolve once it has actually exited. */
  async function stop() {
    const p = proc;
    if (!p) return;
    proc = null;
    ready = null;
    const exited = new Promise((r) => (p.exitCode !== null || p.signalCode ? r() : p.once("exit", r)));
    try { p.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
    try { unlinkSync(sockPath); } catch {}
  }

  return { ensure, stop, sockPath, get pid() { return proc?.pid ?? null; } };
}
