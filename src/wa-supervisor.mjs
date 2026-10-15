#!/usr/bin/env node
// `wa join --keep-alive`: run the daemon under a restart-on-kill supervisor
// (#138). Same env and stdio as the daemon would have had; see supervise.mjs
// for the restart rules.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSupervisor } from "./supervise.mjs";

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "wa-daemon.mjs");
const ts = () => new Date().toTimeString().slice(0, 8);

const sup = createSupervisor({
  start: () => spawn(process.execPath, [DAEMON], { stdio: "inherit", env: process.env }),
  log: (m) => console.log(`${ts()} supervisor: ${m}`),
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => sup.stop(sig));

process.exit(await sup.run());
