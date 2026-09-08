// Connect to the afrolabs open-space as "claude", find David, walk over, and
// stay near him. Presence lasts as long as this process runs.
//
//   node src/find-david.mjs [targetName]

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

function roster() {
  const ps = wa.listPlayers();
  return ps.length ? ps.map((p) => `${JSON.stringify(p.name)}@(${p.x|0},${p.y|0})`).join(", ") : "(nobody visible)";
}

await wa.connect();
log("connected. my spawn:", `(${wa.pos.x|0},${wa.pos.y|0})`);

// Give the server a moment to stream the current room occupants.
await new Promise((r) => setTimeout(r, 6000));
log("roster:", roster());

let target = wa.findPlayer(TARGET);

if (!target) {
  log(`${TARGET} not visible yet — wandering to search…`);
  const spots = [[800, 800], [1600, 400], [2600, 1200], [1600, 1900], [500, 1600], [1000, 1000]];
  for (const [x, y] of spots) {
    await wa.navTo(x, y, { timeoutMs: 15000, stopWithin: 64 });
    target = wa.findPlayer(TARGET);
    if (target) break;
    log("  …still searching. roster:", roster());
  }
}

if (!target) {
  log(`could not find ${TARGET}. Holding position; will keep watching.`);
} else {
  log(`found ${JSON.stringify(target.name)} #${target.userId} at (${target.x|0},${target.y|0}) — walking over`);
  const res = await wa.navTo(target.x, target.y, {
    stopWithin: 48,
    getTarget: () => wa.players.get(target.userId) || null,
    timeoutMs: 90000,
  });
  log("walk result:", JSON.stringify(res));
  if (res.arrived) {
    wa.say(`hi ${target.name} — found you`);
    log(`said hi to ${target.name}`);
  }
}

// Hold presence: loosely follow the target, report every 3s. Ctrl-C to leave.
setInterval(() => {
  const me = `(${wa.pos.x|0},${wa.pos.y|0})`;
  const t = target ? wa.players.get(target.userId) : null;
  if (t) {
    const d = Math.hypot(t.x - wa.pos.x, t.y - wa.pos.y) | 0;
    log(`me ${me}  ${target.name} (${t.x|0},${t.y|0})  dist ${d}`);
    if (d > 160) wa.navTo(t.x, t.y, { stopWithin: 64, getTarget: () => wa.players.get(target.userId) || null, timeoutMs: 30000 });
  } else {
    log(`me ${me}  roster: ${roster()}`);
    if (!target) { const found = wa.findPlayer(TARGET); if (found) { target = found; log(`${TARGET} appeared at (${found.x|0},${found.y|0})`); } }
  }
}, 3000);

process.on("SIGINT", () => { log("leaving room"); wa.close(); setTimeout(() => process.exit(0), 200); });
