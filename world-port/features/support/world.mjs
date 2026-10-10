import { readFileSync } from "node:fs";
import { setDefaultTimeout, setWorldConstructor, World } from "@cucumber/cucumber";
import { FakeServer } from "../../fake/fake-server.mjs";
import { FakeWorld } from "../../fake/fake-world.mjs";
import { EVENTS, waitFor } from "../../port.mjs";
import { WORLDS } from "../../worlds/index.mjs";

const kind = process.env.WORLD ?? "fake";

// Live avatars now walk (pathfinding), so a step can take far longer than cucumber's default 5 s.
setDefaultTimeout(kind === "live" ? 180000 : 5000);

// Missing facts file loads as {}; anything else (bad JSON) throws.
const loadFacts = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
};

class ScenarioWorld extends World {
  constructor(opts) {
    super(opts);
    this.kind = kind;
    this.worldId = null; // set by the "Given the world" step
    this.avatars = new Map(); // role -> WorldPort
    this.server = new FakeServer(); // shared per scenario so fake avatars see each other
    this.events = new Map(); // role -> [{ event, payload }], everything that avatar has been told
  }

  /**
   * Resolve with the first `event` payload at/after log index `since` satisfying `predicate`: from what
   * `role` was already told (the fake announces synchronously) or, failing that, what arrives next.
   */
  async observe(role, event, predicate = () => true, { since = 0, timeoutMs = 15000 } = {}) {
    const a = await this.avatar(role);
    const seen = this.events.get(role).slice(since).find((e) => e.event === event && predicate(e.payload));
    return seen ? seen.payload : waitFor(a, event, predicate, timeoutMs);
  }

  /** The facts file of the current world ({} if none). */
  get facts() {
    const world = WORLDS[this.worldId];
    return world ? loadFacts(world.factsFile) : {};
  }

  /** The avatar for `role`, created on first use with `opts`. Role "A" -> wa-probe-a. */
  async avatar(role, opts = {}) {
    if (this.avatars.has(role)) return this.avatars.get(role);
    const name = `wa-probe-${role.toLowerCase()}`;
    const world = WORLDS[this.worldId];
    if (!world) throw new Error(`unknown world "${this.worldId}"`);
    let port;
    if (kind === "live") {
      const { LiveWorld } = await import("../../live/live-world.mjs"); // Task 2; only when WORLD=live
      port = new LiveWorld({ name, roomUrl: world.roomUrl, ...opts });
    } else {
      port = new FakeWorld({ server: this.server, name, facts: this.facts, dwellMs: 50, lingerMs: 50, ...opts });
    }
    const log = [];
    for (const event of EVENTS) port.on(event, (payload) => log.push({ event, payload }));
    this.events.set(role, log);
    this.avatars.set(role, port);
    return port;
  }
}

setWorldConstructor(ScenarioWorld);
