#!/usr/bin/env node
// `npm run scenarios [-- <feature paths / cucumber flags>]`. Runs cucumber-js over
// world-port/features unless the caller names paths: cucumber MERGES `paths` from
// config and command line, so a default in cucumber.mjs would defeat narrowing.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const names = (a) => a.endsWith(".feature") || (!a.startsWith("-") && existsSync(a));
// A positional that is a flag's value (e.g. `--tags @x`) is not a path; only .feature
// files and existing directories count.
const hasPath = args.some(names);
const bin = "node_modules/@cucumber/cucumber/bin/cucumber.js";
const r = spawnSync(process.execPath, [bin, ...args, ...(hasPath ? [] : ["world-port/features"])], { stdio: "inherit" });
process.exit(r.status ?? 1);
