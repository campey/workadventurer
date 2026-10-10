#!/usr/bin/env node
// Probe runner: node world-port/probes/run.mjs <probe> [--world <key>]
// Runs one probe against prod with recording on, prints the question, what was
// observed and the verdict, saves the raw (git-ignored) recordings, and closes
// every avatar however the probe ends.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LiveWorld } from "../live/live-world.mjs";
import { save } from "../recorder.mjs";
import { WORLDS } from "../worlds/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const probes = () =>
  readdirSync(here).filter((f) => f.endsWith(".mjs") && f !== "run.mjs").map((f) => f.slice(0, -4));

function usage() {
  console.error(
    `usage: node world-port/probes/run.mjs <probe> [--world <key>]\n` +
      `  probes: ${probes().join(", ")}\n` +
      `  worlds: ${Object.keys(WORLDS).map((k) => `"${k}"`).join(", ")}`,
  );
}

function parseArgs(argv) {
  const out = { probe: null, world: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--world") out.world = argv[++i] ?? null;
    else if (!out.probe) out.probe = argv[i];
    else return { error: `unexpected argument: ${argv[i]}` };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error || !args.probe) {
    if (args.error) console.error(args.error);
    usage();
    return 2;
  }
  if (!existsSync(path.join(here, `${args.probe}.mjs`)) || args.probe === "run") {
    console.error(`unknown probe: ${args.probe}`);
    usage();
    return 2;
  }
  const probe = (await import(pathToFileURL(path.join(here, `${args.probe}.mjs`)).href)).default;
  const worldKey = args.world ?? probe.world;
  const world = WORLDS[worldKey];
  if (!world) {
    console.error(`unknown world: ${worldKey}`);
    usage();
    return 2;
  }

  console.log(`probe: ${args.probe}\nworld: ${worldKey}\nquestion: ${probe.question}`);
  const avatars = new Map(); // role -> { world, sink }
  const ctx = {
    world: { key: worldKey, ...world },
    avatar(role, { versionHash = null } = {}) {
      const sink = [];
      const name = `wa-probe-${String(role).toLowerCase()}`;
      const w = new LiveWorld({ roomUrl: world.roomUrl, name, versionHash, recordTo: sink });
      avatars.set(role, { world: w, sink, name });
      return w;
    },
    log: (msg) => console.log(`  ${msg}`),
  };

  let code = 0;
  try {
    const { observed, verdict, note } = await probe.run(ctx);
    console.log(`observed: ${JSON.stringify(observed, null, 2)}`);
    console.log(`verdict: ${verdict}\nnote: ${note}`);
  } catch (e) {
    console.error(`probe failed: ${e?.message ?? e}`);
    code = 1;
  } finally {
    for (const { world: w } of avatars.values()) {
      try { w.close(); } catch (e) { console.error(`close failed: ${e.message}`); }
    }
    for (const { sink, name } of avatars.values()) {
      try { console.log(`recording: ${save(sink, name)}`); } catch (e) { console.error(`save failed: ${e.message}`); }
    }
  }
  return code;
}

process.exitCode = await main();
// Force exit: a failed connect must not leave sockets or timers holding the process open.
process.exit(process.exitCode);
