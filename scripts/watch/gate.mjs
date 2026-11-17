// Adapter watcher, step 3: the gate (#127). Runs the checks a candidate adapter must
// pass before it may reach the catalog, in order, and reports each step:
//   proto-diff   no wire change the clients use (Node family: src/; wa-1.33: android/)
//   selfcheck    the CLI joins, moves, bubbles and enters an area with the candidate
//   scenarios    the live scenario suite (production only: staging has no world facts)
//   kotlin-smoke wa-cli with the candidate's hash joins and walks to an area
//
// The steps are INJECTED runners (`runners[name](ctx) -> { ok, detail? }`), so the gate's
// own logic is tested with fakes. Default runner factories for the real checks live here
// too, thin wrappers over the existing scripts; the workflow wires them in (Task 6).
//
// runGate never throws and never hangs: a runner that throws, returns rubbish, or runs past
// its timeout is a failed step, and the steps after a failure are not run (they would put
// live avatars on a server for a verdict that is already "fail").

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gateDetail } from "../../src/catalog/recover.mjs";
import { diffProtos, readNodeSources, readKotlinSources } from "../proto-diff.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const STEP_NAMES = ["proto-diff", "selfcheck", "scenarios", "kotlin-smoke"];

/** Per-step time limits in ms (a live scenario run and a Gradle build are slow). */
export const DEFAULT_TIMEOUTS = {
  "proto-diff": 60_000,
  selfcheck: 120_000,
  scenarios: 15 * 60_000,
  "kotlin-smoke": 10 * 60_000,
};

const MIN_REASON = "no detail";
const text = (v) => gateDetail(typeof v === "string" ? v : v == null ? "" : String(v)) || undefined;

/** Run one runner with a timeout; always resolves { status, detail }. */
async function runStep(name, runner, ctx, timeoutMs) {
  if (typeof runner !== "function") return { name, status: "fail", detail: "no runner configured for this step" };
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  try {
    const out = await Promise.race([Promise.resolve().then(() => runner({ ...ctx, signal: ac.signal })), timeout]);
    if (out?.timedOut) return { name, status: "fail", detail: `timed out after ${Math.round(timeoutMs / 1000)}s` };
    if (!out || typeof out !== "object" || typeof out.ok !== "boolean") {
      return { name, status: "fail", detail: "runner returned an unusable result" };
    }
    const detail = text(out.detail);
    return { name, status: out.ok ? "pass" : "fail", ...(detail ? { detail } : out.ok ? {} : { detail: MIN_REASON }) };
  } catch (e) {
    return { name, status: "fail", detail: text(`runner crashed: ${e?.message ?? e}`) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the gate on a candidate adapter.
 *   file            the candidate adapter file object (from buildCandidate)
 *   server          "production" | "staging"
 *   candidateFile   path the clients read it from; written from `file` into a temp dir when omitted
 *   candidateProto  path to the candidate's messages.proto (for the proto-diff step)
 *   runners         { "proto-diff", selfcheck, scenarios, "kotlin-smoke" } each (ctx) => { ok, detail? }
 *   timeouts        per-step overrides of DEFAULT_TIMEOUTS
 * Returns { pass, steps: [{ name, status: "pass"|"fail"|"skipped", detail? }], candidateFile }.
 */
export async function runGate({ file, server, candidateFile, candidateProto, runners = {}, timeouts = {}, log = () => {} } = {}) {
  const steps = [];
  const result = () => ({
    pass: steps.length === STEP_NAMES.length && steps.every((s) => s.status === "pass" || (s.status === "skipped" && s.detail?.startsWith("production only"))),
    steps,
    candidateFile: candidateFile ?? null,
  });
  const fill = (from, why) => {
    for (const name of STEP_NAMES.slice(from)) steps.push({ name, status: "skipped", detail: why });
  };
  try {
    if (!file || typeof file !== "object") {
      fill(0, "not run: no candidate adapter");
      steps[0] = { name: STEP_NAMES[0], status: "fail", detail: "no candidate adapter file given" };
      return result();
    }
    if (server !== "production" && server !== "staging") {
      steps.push({ name: STEP_NAMES[0], status: "fail", detail: `server must be production or staging, got "${server}"` });
      fill(1, "not run: bad server");
      return result();
    }
    if (!candidateFile) {
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-gate-"));
        candidateFile = path.join(dir, `${file.apiVersionHash ?? "candidate"}.json`);
        fs.writeFileSync(candidateFile, `${JSON.stringify(file, null, 2)}\n`);
      } catch (e) {
        candidateFile = undefined;
        steps.push({ name: STEP_NAMES[0], status: "fail", detail: text(`could not write the candidate file: ${e.message}`) });
        fill(1, "not run: no candidate file");
        return result();
      }
    }
    const ctx = { file, hash: file.apiVersionHash, server, candidateFile, candidateProto };

    for (let i = 0; i < STEP_NAMES.length; i++) {
      const name = STEP_NAMES[i];
      if (name === "scenarios" && server !== "production") {
        steps.push({ name, status: "skipped", detail: "production only: the scenarios' world facts are production worlds" });
        continue;
      }
      log(`gate: ${name}`);
      const step = await runStep(name, runners[name], ctx, timeouts[name] ?? DEFAULT_TIMEOUTS[name]);
      steps.push(step);
      if (step.status === "fail") {
        fill(i + 1, `not run: ${name} failed`);
        break;
      }
    }
    return result();
  } catch (e) {
    // Defensive: nothing above should throw.
    const done = steps.length;
    if (done < STEP_NAMES.length) {
      steps.push({ name: STEP_NAMES[done], status: "fail", detail: text(`gate error: ${e?.message ?? e}`) });
      fill(done + 1, "not run: gate error");
    }
    return result();
  }
}

// ---------------------------------------------------------------------------
// Default runner factories (real checks). Not exercised live in tests: only the
// argument building is unit-tested.
// ---------------------------------------------------------------------------

const withProxy = (env = {}) => ({ NODE_USE_ENV_PROXY: "1", ...env });

/** The proto directory name of an adapter's protoFamily ("wa-1.34" -> proto/wa-1.34/messages.proto). */
export const familyProtoPath = (family, root = repoRoot) => path.join(root, "proto", family, "messages.proto");

/**
 * proto-diff step, in process: the candidate proto against the proto family the Node client
 * uses (a change src/ uses fails) and against wa-1.33, which the Android app is built on
 * (a change android/ uses fails: additive only).
 */
export function createProtoDiffRunner({ root = repoRoot, nodeSources, kotlinSources } = {}) {
  return async ({ file, candidateProto }) => {
    if (!candidateProto || !fs.existsSync(candidateProto)) return { ok: false, detail: "no candidate proto to compare" };
    const src = nodeSources ?? readNodeSources(root);
    const android = kotlinSources ?? readKotlinSources(root);
    const checks = [
      { label: `${file.protoFamily} (Node)`, old: familyProtoPath(file.protoFamily, root), sources: { src } },
      { label: "wa-1.33 (Android)", old: familyProtoPath("wa-1.33", root), sources: { android } },
    ];
    for (const c of checks) {
      if (!fs.existsSync(c.old)) return { ok: false, detail: `no vendored proto for ${c.label}` };
      const d = diffProtos(c.old, candidateProto, { sources: c.sources });
      const hit = d.breaking.find((b) => b.usedBy.length);
      if (hit) return { ok: false, detail: `vs ${c.label}: used by ${hit.usedBy.map((u) => `${u}/`).join(" and ")}: ${hit.text}` };
    }
    return { ok: true };
  };
}

/** `node scripts/selfcheck.mjs` for the candidate; staging uses wa-master's target with the staging room, pusher and woka. */
export function selfcheckInvocation({ candidateFile, server, staging = {}, root = repoRoot }) {
  const args = [path.join(root, "scripts/selfcheck.mjs"), "--target", server === "staging" ? "wa-master" : "production", "--adapter-file", candidateFile];
  const env = withProxy();
  if (server === "staging") {
    if (staging.room) args.push("--room", staging.room);
    if (staging.pusherUrl) env.WA_PUSHER_URL = staging.pusherUrl;
    if (staging.wokaId) env.WA_WOKA_ID = staging.wokaId;
  }
  return { command: process.execPath, args, env, cwd: root };
}

/** `npm run scenarios` against the live world with the candidate; production only. */
export function scenariosInvocation({ candidateFile, server, root = repoRoot }) {
  if (server !== "production") throw new Error("the live scenarios run on production only");
  return {
    command: process.execPath,
    args: [path.join(root, "scripts/scenarios.mjs")],
    env: withProxy({ WORLD: "live", WA_ADAPTER_FILE: candidateFile }),
    cwd: root,
  };
}

/** `wa-cli --api-version <hash> --walk-to-area <area>` through Gradle; staging passes its own room and pusher. */
export function kotlinSmokeInvocation({ hash, server, staging = {}, area = "Red Table", seconds = 30, name = "adapter-gate", root = repoRoot }) {
  const words = ["--name", name, "--api-version", hash, "--seconds", String(seconds), "--walk-to-area", area.includes(" ") ? `'${area}'` : area];
  if (server === "staging") {
    if (staging.room) words.push("--room", staging.room);
    if (staging.pusherUrl) words.push("--pusher", staging.pusherUrl);
  }
  return {
    command: "./gradlew",
    args: ["--console=plain", ":wa-cli:run", `--args=${words.join(" ")}`],
    env: {},
    cwd: path.join(root, "android"),
  };
}

/** The line to show for a failed child: the first line that says FAIL/error, else the last line. */
export function firstFailure(output) {
  const lines = String(output ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /\bFAIL\b|\bfailed\b|\berror\b|join failed|closed:/i.test(l)) ?? lines.at(-1) ?? "no output";
}

/** Run a child, keep the last 16 KB of its output, kill it when `signal` aborts. Resolves { code, output }. */
export function runChild({ command, args = [], env = {}, cwd, signal, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawnFn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, output: `could not start ${command}: ${e.message}` });
      return;
    }
    const keep = (d) => { output = (output + d).slice(-16384); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const kill = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => resolve({ code: null, output: `${output}\nerror: ${e.message}` }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      resolve({ code, output });
    });
  });
}

const childResult = ({ code, output }, extraOk = () => true) =>
  code === 0 && extraOk(output) ? { ok: true } : { ok: false, detail: code === 0 ? "ran but did not reach the goal: " + firstFailure(output) : firstFailure(output) };

/** selfcheck step: exit 0 with the candidate file. */
export function createSelfcheckRunner({ staging, run = runChild, root } = {}) {
  return async ({ candidateFile, server, signal }) =>
    childResult(await run({ ...selfcheckInvocation({ candidateFile, server, staging, root }), signal }));
}

/** Live scenarios step: production only; a fail-closed refusal elsewhere. */
export function createScenariosRunner({ run = runChild, root } = {}) {
  return async ({ candidateFile, server, signal }) => {
    if (server !== "production") return { ok: false, detail: "the live scenarios run on production only" };
    return childResult(await run({ ...scenariosInvocation({ candidateFile, server, root }), signal }));
  };
}

/** Kotlin smoke step: exit 0 and the walk reached the area. */
export function createKotlinSmokeRunner({ staging, area, run = runChild, root } = {}) {
  return async ({ hash, server, signal }) =>
    childResult(await run({ ...kotlinSmokeInvocation({ hash, server, staging, area, root }), signal }), (o) => /walk ended: ARRIVED/.test(o));
}

/** All four default runners. `staging` is { room, pusherUrl, wokaId, area }. */
export function defaultRunners(opts = {}) {
  return {
    "proto-diff": createProtoDiffRunner(opts),
    selfcheck: createSelfcheckRunner(opts),
    scenarios: createScenariosRunner(opts),
    "kotlin-smoke": createKotlinSmokeRunner({ ...opts, area: opts.area }),
  };
}
