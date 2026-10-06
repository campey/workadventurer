// Per-port daemon advertisement + log paths (issue #65).
//
// Every daemon used to write the same `daemon.json` / `wa-daemon.json` (last
// writer wins) and the CLI logged every detached daemon to one `daemon.log`,
// so a bare `wa status` addressed whichever daemon started last and an exiting
// daemon deleted a survivor's advertisement. Now: `daemon-<port>.json` in each
// dir, `daemon-<port>.log`, and a daemon only ever removes its own file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class AmbiguousDaemonError extends Error {
  constructor(daemons) {
    const rows = daemons.map((d) => `  port ${d.port}  ${d.name ?? "?"}  pid ${d.pid}${d.room ? `  ${d.room}` : ""}`);
    super(`several daemons are running — pass --port to choose one:\n${rows.join("\n")}`);
    this.name = "AmbiguousDaemonError";
    this.daemons = daemons;
  }
}

const FILE_RE = /^daemon-(\d+)\.json$/;

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

export const defaultDirs = () => [os.tmpdir(), path.join(os.homedir(), ".workadventurer")];

export function createRegistry({ dirs = defaultDirs() } = {}) {
  const file = (dir, port) => path.join(dir, `daemon-${port}.json`);

  function advertise({ port, pid = process.pid, name, room, startedAt = new Date().toISOString() }) {
    const info = JSON.stringify({ pid, port, room, name, startedAt });
    for (const d of dirs) {
      try {
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(file(d, port), info);
      } catch {}
    }
  }

  // Only the daemon that wrote the file may remove it: a stale daemon's late
  // shutdown must not take down the advertisement of whoever now owns the port.
  function withdraw(port, pid = process.pid) {
    for (const d of dirs) {
      try {
        const cur = JSON.parse(fs.readFileSync(file(d, port), "utf8"));
        if (cur.pid === pid) fs.unlinkSync(file(d, port));
      } catch {}
    }
  }

  /** Live daemons, de-duplicated by port; advertisements with a dead pid are pruned. */
  function list() {
    const byPort = new Map();
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(d); } catch { continue; }
      for (const n of names) {
        const m = FILE_RE.exec(n);
        if (!m) continue;
        const p = path.join(d, n);
        let info;
        try { info = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
        if (!info || Number(info.port) !== Number(m[1]) || !Number.isInteger(info.pid)) continue;
        if (!pidAlive(info.pid)) { try { fs.unlinkSync(p); } catch {} continue; }
        byPort.set(info.port, info);
      }
    }
    return [...byPort.values()].sort((a, b) => a.port - b.port);
  }

  /**
   * Which port a command that addresses a running daemon should use.
   * explicit (flag / env / config) wins; else the one live daemon; else the
   * default; several live daemons is an error rather than a guess.
   */
  function resolvePort({ explicit, fallback }) {
    if (explicit) return Number(explicit);
    const live = list();
    if (live.length === 1) return live[0].port;
    if (live.length > 1) throw new AmbiguousDaemonError(live);
    return fallback;
  }

  const logPath = (port) => path.join(dirs[dirs.length - 1], `daemon-${port}.log`);

  return { dirs, advertise, withdraw, list, resolvePort, logPath };
}
