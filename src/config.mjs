// Config resolution for the `wa` CLI and the daemon.
//
// Precedence, lowest to highest:
//   1. built-in DEFAULTS (from wa-client.mjs) + port 8787
//   2. ~/.config/workadventurer/config.json
//   3. environment variables
//   4. explicit flags passed in

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS as CLIENT_DEFAULTS } from "./wa-client.mjs";

export const CONFIG_PATH = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "workadventurer",
  "config.json"
);

const BASE = {
  roomUrl: CLIENT_DEFAULTS.roomUrl,
  name: CLIENT_DEFAULTS.name,
  pusherUrl: CLIENT_DEFAULTS.pusherUrl,
  version: CLIENT_DEFAULTS.version, // null unless WA_VERSION / flag set
  target: CLIENT_DEFAULTS.target, // "auto"
  wokaId: CLIENT_DEFAULTS.wokaId,
  port: 8787,
  transcript: null, // WA_STT_TRANSCRIPT=<path> -> append finals as JSONL (issue #64)
  stt: false, // WA_STT=1 -> live speech-to-text on inbound peer audio (issue #23, prototype)
  ttsPython: "python3", // WA_TTS_PYTHON -> interpreter for huggingsesame's say.py (issue #7)
  ttsSay: path.join(os.homedir(), "Code", "huggingsesame", "src", "say.py"), // WA_TTS_SAY
  adapterUpdates: "ask", // WA_ADAPTER_UPDATES: ask | auto | never — downloading adapters (#126)
};

const ENV_MAP = {
  WA_ROOM: "roomUrl",
  WA_NAME: "name",
  WA_PUSHER_URL: "pusherUrl",
  WA_VERSION: "version",
  WA_TARGET: "target",
  WA_WOKA_ID: "wokaId",
  WA_DAEMON_PORT: "port",
  WA_STT: "stt",
  WA_STT_TRANSCRIPT: "transcript",
  WA_TTS_PYTHON: "ttsPython",
  WA_TTS_SAY: "ttsSay",
  WA_ADAPTER_UPDATES: "adapterUpdates",
};

const ADAPTER_UPDATES = ["ask", "auto", "never"];

function fromFile(configPath = CONFIG_PATH) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function fromEnv(env = process.env) {
  const out = {};
  for (const [k, field] of Object.entries(ENV_MAP)) {
    if (env[k] != null && env[k] !== "") out[field] = env[k];
  }
  return out;
}

/**
 * @param {object} flags  explicit overrides (e.g. from CLI args). Unset/undefined
 *                        keys are ignored.
 * @returns {{roomUrl,name,pusherUrl,version,wokaId,port}}
 */
export function resolveConfig(flags = {}, configPath = CONFIG_PATH) {
  const cleanFlags = Object.fromEntries(
    Object.entries(flags).filter(([, v]) => v !== undefined && v !== null)
  );
  const merged = { ...BASE, ...fromFile(configPath), ...fromEnv(), ...cleanFlags };
  merged.port = Number(merged.port) || BASE.port;
  merged.stt = merged.stt === true || merged.stt === "1" || merged.stt === "true";
  if (!ADAPTER_UPDATES.includes(merged.adapterUpdates)) merged.adapterUpdates = BASE.adapterUpdates;
  return merged;
}

// Strict read for the write path: only a missing file means "start fresh".
// Anything we cannot trust is left untouched, so a typo in a hand-edited
// config never costs the user their other settings.
function readConfigStrict(configPath, field, value) {
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw refuse(configPath, field, value, `cannot read it (${err.code || err.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw refuse(configPath, field, value, `it is not valid JSON (${err.message})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw refuse(configPath, field, value, "it is not a JSON object");
  }
  return parsed;
}

function refuse(configPath, field, value, why) {
  const envName = Object.entries(ENV_MAP).find(([, f]) => f === field)?.[0];
  return new Error(
    `Not saving ${field}: ${configPath} ${why}. The file was left untouched. ` +
      `Fix it, or set the value by hand: add ${JSON.stringify(field)}: ${JSON.stringify(value)} to it` +
      (envName ? `, or use ${envName}=${value}.` : ".")
  );
}

/**
 * Persist one field into the config file, keeping the others. Creates the
 * directory and file if missing; writes a temp file then renames so a crash
 * never leaves a half-written config.
 */
export function writeConfigField(field, value, configPath = CONFIG_PATH) {
  const next = { ...readConfigStrict(configPath, field, value), [field]: value };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, configPath);
}

/**
 * The port only if the user actually chose one (flag, WA_DAEMON_PORT, or the
 * config file) — null when it would just be the built-in default. The CLI uses
 * this to decide between "address that port" and "discover the running daemon".
 */
export function explicitPort(flags = {}, env = process.env) {
  const candidates = [flags.port, fromEnv(env).port, fromFile().port];
  for (const c of candidates) {
    const n = Number(c);
    if (n) return n;
  }
  return null;
}

/** The subset that should be handed to a spawned daemon as environment. */
export function configToEnv(cfg) {
  return {
    WA_ROOM: cfg.roomUrl,
    WA_NAME: cfg.name,
    WA_PUSHER_URL: cfg.pusherUrl,
    WA_TARGET: cfg.target,
    WA_WOKA_ID: cfg.wokaId,
    WA_DAEMON_PORT: String(cfg.port),
    WA_STT: cfg.stt ? "1" : "0",
    ...(cfg.transcript ? { WA_STT_TRANSCRIPT: cfg.transcript } : {}),
    WA_TTS_PYTHON: cfg.ttsPython,
    WA_TTS_SAY: cfg.ttsSay,
    WA_ADAPTER_UPDATES: cfg.adapterUpdates,
    ...(cfg.version ? { WA_VERSION: cfg.version } : {}),
  };
}
