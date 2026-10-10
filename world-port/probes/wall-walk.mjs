// Wall walk: an avatar walks to obstacles near the spawn and stops on the open
// side facing each, then stands on open floor; a person watching in a browser
// answers each stop by emote (👍 good / 😂 wrong, see human-check.mjs). Only
// stops answered 👍 become landmarks in the world's facts file. It starts with
// a 👍 handshake, so nothing moves until the person can see the avatar.
//   node world-port/probes/run.mjs wall-walk --world "<key>"
// Uses the client's baked collision map (map/<room>/collision.json) and its
// pathfinding; the facts entries use the confirmedBy shown in `note`.
import { askHuman } from "./human-check.mjs";

const DIRS = [[1, 0, "left"], [-1, 0, "right"], [0, 1, "above"], [0, -1, "below"]]; // obstacle is <side> of the avatar
const ARROW = { left: "←", right: "→", above: "↑", below: "↓" };

// Obstacle tiles with a free 4-neighbour to stand on, nearest the spawn first, 5+ tiles apart.
function pickObstacles(nav, sx, sy, want = 4) {
  const picked = [];
  for (let r = 2; r <= 18 && picked.length < want; r++)
    for (let ty = sy - r; ty <= sy + r; ty++)
      for (let tx = sx - r; tx <= sx + r; tx++) {
        if (Math.max(Math.abs(tx - sx), Math.abs(ty - sy)) !== r) continue;
        if (!nav.inBounds(tx, ty) || !nav.isTileBlocked(tx, ty)) continue;
        if (!picked.every((p) => Math.hypot(p.tx - tx, p.ty - ty) >= 5)) continue;
        for (const [dx, dy, side] of DIRS) {
          const ox = tx + dx, oy = ty + dy;
          if (!nav.isTileBlocked(ox, oy)) { picked.push({ tx, ty, ox, oy, side }); break; }
        }
        if (picked.length === want) return picked;
      }
  return picked;
}

function pickOpen(nav, sx, sy, want = 2) {
  const out = [];
  for (const [dx, dy] of [[4, 0], [-4, 2], [0, 5], [6, -3], [-6, -4], [3, 6]]) {
    const f = nav.nearestFree(sx + dx, sy + dy);
    if (f && DIRS.every(([a, b]) => !nav.isTileBlocked(f[0] + a, f[1] + b))) out.push(f);
    if (out.length === want) break;
  }
  return out;
}

export default {
  question: "Does the avatar stop at the walls the collision map reports, as a person sees it in a browser?",
  world: "afrolabs open space",
  async run(ctx) {
    const a = ctx.avatar("walls");
    await a.connect();
    const c = a.client;
    const nav = c.nav;
    if (!nav) throw new Error("inconclusive: no collision map for this room");
    const ask = (prompt) => askHuman(a, prompt, { log: ctx.log });

    const start = await ask("wall walk: 👍 when you can see me, 😂 to cancel");
    if (start !== "good") throw new Error(`inconclusive: not started (${start})`);

    const [sx, sy] = nav.pxToTile(c.pos.x, c.pos.y);
    const stops = [];
    let n = 0;
    for (const k of pickObstacles(nav, sx, sy)) {
      n++;
      const [ox, oy] = nav.tileCenterPx(k.ox, k.oy);
      const [bx, by] = nav.tileCenterPx(k.tx, k.ty);
      const r = await c.navTo(ox, oy, { stopWithin: 6, timeoutMs: 45000 });
      c._faceToward?.(bx, by);
      const v = await ask(`#${n}: wall ${ARROW[k.side]} — did I stop at it?`);
      stops.push({ n, solid: true, x: bx | 0, y: by | 0, side: k.side, standing: [c.pos.x | 0, c.pos.y | 0], reached: !!r?.arrived, answer: v });
      ctx.log(`#${n} solid (${bx | 0},${by | 0}), obstacle ${k.side} of me: ${v}`);
    }
    for (const f of pickOpen(nav, sx, sy)) {
      n++;
      const [px, py] = nav.tileCenterPx(f[0], f[1]);
      const r = await c.navTo(px, py, { stopWithin: 6, timeoutMs: 45000 });
      const v = await ask(`#${n}: open floor — am I standing on it?`);
      stops.push({ n, solid: false, x: px | 0, y: py | 0, reached: !!r?.arrived, answer: v });
      ctx.log(`#${n} open (${px | 0},${py | 0}): ${v}`);
    }
    a.speechBubble("wall walk done — thanks!");

    const answered = stops.filter((s) => s.answer !== "no answer");
    if (!answered.length) throw new Error("inconclusive: no stop was answered");
    const wrong = answered.filter((s) => s.answer === "wrong");
    return {
      observed: { stops },
      verdict: wrong.length ? "contradicts" : "confirms",
      note: wrong.length
        ? `${wrong.length} stop(s) answered 😂: the collision map disagrees with what the person saw there (a gap to probe)`
        : `every answered stop was 👍; add them to landmarks with confirmedBy: "campey, browser (wall walk), <date>"`,
    };
  },
};
