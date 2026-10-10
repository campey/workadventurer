import { readFileSync } from "node:fs";
import { setWorldConstructor, World } from "@cucumber/cucumber";
import { FakeServer } from "../../fake/fake-server.mjs";
import { FakeWorld } from "../../fake/fake-world.mjs";
import { WORLDS } from "../../worlds/index.mjs";

const kind = process.env.WORLD ?? "fake";

// Missing facts file (Task 4 creates them) loads as {}; anything else (bad JSON) throws.
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
      port = new FakeWorld({ server: this.server, name, facts: loadFacts(world.factsFile), ...opts });
    }
    this.avatars.set(role, port);
    return port;
  }
}

setWorldConstructor(ScenarioWorld);
