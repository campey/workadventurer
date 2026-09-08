// Connect to the afrolabs open-space as "claude", find a named player, walk
// over, and follow them for as long as this process runs.
//
//   node src/find-player.mjs [targetName]      (targetName defaults to "David")

import { WorkAdventureClient } from "./wa-client.mjs";

const TARGET = process.argv[2] || "David";
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);

const wa = new WorkAdventureClient({ name: "claude" });

wa.on("log", (m) => log("·", m));
wa.on("error", (e) => log("!! error:", e.message));
wa.on("close", (c) => { log("socket closed:", c.code, c.reason || ""); process.exit(c.code === 1000 ? 0 : 1); });
wa.on("playerJoined", (p) => log(`+ player ${JSON.stringify(p.name)} #${p.userId} @ (${p.x|0},${p.y|0})`));
wa.on("playerLeft", (id) => log(`- player #${id} left`));

const roster = () => {
  const ps = wa.listPlayers();
  return ps.length ? ps.map((p) => `${JSON.stringify(p.name)}@(${p.x|0},${p.y|0})`).join(", ") : "(nobody visible)";
};
const liveTarget = () => (target ? wa.players.get(target.userId) || null : null);

await wa.connect();
log(`connected as "claude" — spawned at (${wa.pos.x|0},${wa.pos.y|0})`);

// Let the server stream the current room occupants.
await new Promise((r) => setTimeout(r, 5000));
log("roster:", roster());

let target = wa.findPlayer(TARGET);

if (!target) {
  log(`${TARGET} not visible yet — wandering to search…`);
  for (const [x, y] of [[1600, 1520], [2400, 1000], [1900, 1800], [900, 1600], [1300, 900]]) {
    await wa.navTo(x, y, { timeoutMs: 15000, stopWithin: 64 });
    target = wa.findPlayer(TARGET);
    if (target) break;
    log("  …still searching. roster:", roster());
  }
}

if (!target) {
  log(`could not find ${TARGET}. Holding position; will keep watching.`);
  setInterval(() => {
    const found = wa.findPlayer(TARGET);
    if (found) { target = found; log(`${TARGET} appeared at (${found.x|0},${found.y|0}) — going over`); approachAndFollow(); }
  }, 4000);
} else {
  approachAndFollow();
}

async function approachAndFollow() {
  const t = liveTarget();
  log(`found ${JSON.stringify(target.name)} #${target.userId} at (${t.x|0},${t.y|0}) — heading over`);
  const res = await wa.navTo(t.x, t.y, { stopWithin: 96, getTarget: liveTarget, timeoutMs: 90000 });
  log("approach:", JSON.stringify(res));
  wa.say(`hi ${target.name}`);

  // Fluid continuous follow. Stops one "personal space" short; if the target is
  // in an enclosed room, waits just outside instead of walking in.
  let lastNote = 0;
  const noteTimer = setInterval(() => {
    const lt = liveTarget();
    if (!lt) return;
    const d = Math.hypot(lt.x - wa.pos.x, lt.y - wa.pos.y) | 0;
    const room = wa.nav?.roomAt(lt.x, lt.y);
    log(`following ${target.name}: me (${wa.pos.x|0},${wa.pos.y|0}) them (${lt.x|0},${lt.y|0}) dist ${d}${room ? ` — they're in "${room.name}", holding outside` : ""}`);
  }, 5000);

  const r = await wa.follow(liveTarget, { spacing: 80 });
  clearInterval(noteTimer);
  log("follow ended:", JSON.stringify(r));
}

process.on("SIGINT", () => { log("leaving room"); wa.close(); setTimeout(() => process.exit(0), 200); });
