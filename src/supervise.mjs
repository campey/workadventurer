// Restart-on-kill supervision for the daemon (issue #138).
//
// Since the reconnect chain became indefinite (#144) and dead sockets are
// terminated by the heartbeat (#147), a network outage no longer ends the
// daemon. What is left to recover from is the daemon being killed — an OOM
// abort (#29), SIGKILL. Only something that was alive is restarted:
//   exit 0   deliberate stop (`wa leave`, SIGINT/SIGTERM)  -> stop
//   exit 1   never connected / generic failure             -> stop
//   exit 2,3 usage / port in use                           -> stop
//   exit 4   the server refuses this client (NEW_VERSION)  -> stop; restarting
//            would just hammer the server
//   signal / any other code                                -> restart, with backoff

export const REFUSED_EXIT = 4;
export const DEFAULT_DELAYS = [2000, 5000, 10000, 20000, 30000, 60000];
const NO_RESTART = new Set([0, 1, 2, 3, REFUSED_EXIT]);

export const shouldRestart = ({ code, signal }) => (signal ? true : !NO_RESTART.has(code));

export function createSupervisor({
  start, // () => child process (EventEmitter with kill())
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  delays = DEFAULT_DELAYS,
  stableMs = 5 * 60_000, // a run this long means the next crash starts the backoff over
}) {
  let child = null;
  let stopped = false;
  let wake = null; // resolves the backoff wait early when stop() is called

  async function run() {
    let crashes = 0; // consecutive, reset by a stable run
    for (;;) {
      const startedAt = now();
      child = start();
      const { code, signal } = await new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal }))
      );
      child = null;
      if (stopped) return 0; // we asked it to go (stop() forwarded a signal)
      if (!shouldRestart({ code, signal })) {
        if (code === REFUSED_EXIT) log("the server refuses this client — not restarting");
        else if (code !== 0) log(`daemon exited with code ${code} before/without a live session — not restarting`);
        return code ?? 0;
      }
      if (now() - startedAt >= stableMs) crashes = 0;
      const delay = delays[Math.min(crashes, delays.length - 1)];
      crashes++;
      log(`daemon died (${signal ? `signal ${signal}` : `code ${code}`}), restarting in ${Math.round(delay / 1000)}s (restart #${crashes})`);
      await Promise.race([sleep(delay), new Promise((r) => { wake = r; })]);
      wake = null;
      if (stopped) return 0;
    }
  }

  return {
    run,
    // Forward a termination signal to the daemon; its exit then ends supervision.
    stop(signal = "SIGTERM") {
      stopped = true;
      if (child) child.kill(signal);
      else wake?.();
    },
  };
}
