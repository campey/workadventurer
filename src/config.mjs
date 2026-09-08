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
  version: CLIENT_DEFAULTS.version,
  wokaId: CLIENT_DEFAULTS.wokaId,
  port: 8787,
};

const ENV_MAP = {
  WA_ROOM: "roomUrl",
  WA_NAME: "name",
  WA_PUSHER_URL: "pusherUrl",
  WA_VERSION: "version",
  WA_WOKA_ID: "wokaId",
  WA_DAEMON_PORT: "port",
};

function fromFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
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
export function resolveConfig(flags = {}) {
  const cleanFlags = Object.fromEntries(
    Object.entries(flags).filter(([, v]) => v !== undefined && v !== null)
  );
  const merged = { ...BASE, ...fromFile(), ...fromEnv(), ...cleanFlags };
  merged.port = Number(merged.port) || BASE.port;
  return merged;
}

/** The subset that should be handed to a spawned daemon as environment. */
export function configToEnv(cfg) {
  return {
    WA_ROOM: cfg.roomUrl,
    WA_NAME: cfg.name,
    WA_PUSHER_URL: cfg.pusherUrl,
    WA_VERSION: cfg.version,
    WA_WOKA_ID: cfg.wokaId,
    WA_DAEMON_PORT: String(cfg.port),
  };
}
