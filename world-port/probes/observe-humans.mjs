// Observe real (browser) players walking in and out of a meeting area, from the
// outside, with timestamps: when they join the area's meeting space against when
// their status flips and when their position enters the area, how fast they
// move, and where they are when the browser decides they've entered or left.
//
//   OBSERVE_MINUTES=12 node world-port/probes/run.mjs observe-humans --world "afrolabs open space"
//   node world-port/probes/observe-humans.mjs --analyse world-port/recordings/observe-humans-<time>.jsonl
//
// Two of our avatars:
//   wa-probe-b stands INSIDE the Fire Pit and joins its meeting (LIVEKIT), so it is told
//     when anyone joins or leaves the meeting space (add/update/removeSpaceUser);
//   wa-probe-a stands OUTSIDE (well away from every meeting area) as someone to bubble up
//     with, and records positions, status changes, the browser's currentPlace variable,
//     proximity groups and emotes for every non-probe player in view.
// The people just walk around (e.g. Fire Pit -> our avatar -> another player -> Fire Pit);
// they can mark moments with emotes: 👍 = "I heard a chime now", 😂 = "that looked wrong".
// Stops after OBSERVE_MINUTES (default 10) or on SIGTERM/SIGINT.
//
// The raw log (JSONL) names real players, so it goes to the git-ignored
// world-port/recordings/ only; commit analysis numbers, not names.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATUS = { 0: "UNCHANGED", 1: "ONLINE", 2: "SILENT", 3: "AWAY", 4: "JITSI", 5: "BBB", 6: "DENY_PROXIMITY_MEETING",
  7: "SPEAKER", 8: "BUSY", 9: "DO_NOT_DISTURB", 10: "BACK_IN_A_MOMENT", 11: "LIVEKIT" };
const statusName = (v) => (typeof v === "string" ? v : STATUS[v] ?? String(v));
const isProbe = (n) => (n ?? "").startsWith("wa-probe-");
const here = path.dirname(fileURLToPath(import.meta.url));

/** Signed distance from (x,y) to the rect: negative = inside (depth to the nearest edge), positive = outside. */
export function rectDistance(x, y, r) {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w)), dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  if (dx || dy) return Math.round(Math.hypot(dx, dy));
  return 0 - Math.round(Math.min(x - r.x, r.x + r.w - x, y - r.y, r.y + r.h - y));
}
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : null);

/** Turn a raw event list into the numbers we care about. `pit` is the area rectangle {x,y,w,h,name}. */
export function analyse(events, pit) {
  const humans = [...new Set(events.filter((e) => e.name && !isProbe(e.name) && ["pos", "status", "var"].includes(e.kind)).map((e) => e.name))];
  const out = {};
  for (const name of humans) {
    const mine = events.filter((e) => e.name === name);
    const pos = mine.filter((e) => e.kind === "pos");
    const lastPosBefore = (t) => [...pos].reverse().find((p) => p.t <= t);
    const firstPosAfter = (t) => pos.find((p) => p.t >= t);

    // Speed from relayed position samples (arrival-time jitter: use longer windows too).
    const speeds = [], longSpeeds = [], gaps = [];
    for (let i = 1; i < pos.length; i++) {
      const dt = (pos[i].t - pos[i - 1].t) / 1000;
      gaps.push(dt);
      const d = Math.hypot(pos[i].x - pos[i - 1].x, pos[i].y - pos[i - 1].y);
      if (dt >= 0.05 && dt <= 1 && pos[i].moving && pos[i - 1].moving) speeds.push(d / dt);
    }
    for (let i = 0, j = 0; i < pos.length; i++) {
      while (j < i && (pos[i].t - pos[j].t) / 1000 > 1) j++;
      const k = j - 1 >= 0 ? j - 1 : null; // window just over 1 s
      if (k != null && pos[i].moving && pos[k].moving) {
        const dt = (pos[i].t - pos[k].t) / 1000;
        if (dt >= 1 && dt <= 2) longSpeeds.push(Math.hypot(pos[i].x - pos[k].x, pos[i].y - pos[k].y) / dt);
      }
    }

    // Position-derived area entries/exits.
    const crossings = [];
    let inside = null;
    for (const p of pos) {
      const now = rectDistance(p.x, p.y, pit) <= 0;
      if (inside !== null && now !== inside) crossings.push({ t: p.t, what: now ? "enter" : "exit", x: Math.round(p.x), y: Math.round(p.y), dist: rectDistance(p.x, p.y, pit) });
      inside = now;
    }

    const where = (t) => {
      const b = lastPosBefore(t), a = firstPosAfter(t);
      const f = (p) => (p ? { t: p.t, x: Math.round(p.x), y: Math.round(p.y), dist: rectDistance(p.x, p.y, pit) } : null);
      return { before: f(b), after: f(a) };
    };
    const flips = mine.filter((e) => e.kind === "status").map((e) => ({ t: e.t, status: e.status, ...where(e.t) }));
    const places = mine.filter((e) => e.kind === "var" && e.varName === "currentPlace").map((e) => ({ t: e.t, place: e.value, ...where(e.t) }));
    const spaceEv = events.filter((e) => ["spaceAdd", "spaceRemove"].includes(e.kind) && e.name === name)
      .map((e) => ({ t: e.t, what: e.kind === "spaceAdd" ? "joined space" : "left space", space: e.spaceName }));
    const marks = events.filter((e) => e.kind === "emote" && e.name === name).map((e) => ({ t: e.t, emote: e.emote }));
    const near = (t, list, pick) => { // nearest event of another kind, signed ms (other - this)
      const c = list.map((x) => ({ x, d: x.t - t })).sort((p, q) => Math.abs(p.d) - Math.abs(q.d))[0];
      return c ? { ms: c.d, ...pick(c.x) } : null;
    };
    const entries = crossings.filter((c) => c.what === "enter").map((c) => {
      const next = crossings.find((x) => x.what === "exit" && x.t > c.t);
      return {
        ...c, stayedMs: next ? next.t - c.t : null,
        statusFlip: near(c.t, flips.filter((f) => f.status === "LIVEKIT"), (x) => ({ status: x.status })),
        spaceJoin: near(c.t, spaceEv.filter((s) => s.what === "joined space" && /fire-pit/.test(s.space ?? "")), () => ({})),
        place: near(c.t, places, (x) => ({ place: x.place })),
      };
    });
    const exits = crossings.filter((c) => c.what === "exit").map((c) => ({
      ...c,
      statusFlip: near(c.t, flips.filter((f) => f.status === "ONLINE"), (x) => ({ status: x.status })),
      spaceLeave: near(c.t, spaceEv.filter((s) => s.what === "left space" && /fire-pit/.test(s.space ?? "")), () => ({})),
    }));
    out[name] = {
      samples: pos.length,
      sampleGapMs: { median: Math.round((pct(gaps, 0.5) ?? 0) * 1000), p90: Math.round((pct(gaps, 0.9) ?? 0) * 1000) },
      speedPxPerS: { shortWindow: { median: Math.round(pct(speeds, 0.5) ?? 0), p90: Math.round(pct(speeds, 0.9) ?? 0), max: Math.round(Math.max(0, ...speeds)) },
        oneSecondWindow: { median: Math.round(pct(longSpeeds, 0.5) ?? 0), p90: Math.round(pct(longSpeeds, 0.9) ?? 0), max: Math.round(Math.max(0, ...longSpeeds)) } },
      areaEntries: entries, areaExits: exits, statusFlips: flips, currentPlace: places, spaceMembership: spaceEv, marks,
    };
  }
  return out;
}

export default {
  question: "How do real browser players behave around a meeting area: when do they join the meeting space relative to their status flip and position, how fast do they move, and where are they when the browser decides they've entered or left?",
  world: "afrolabs open space",
  async run(ctx) {
    const minutes = Number(process.env.OBSERVE_MINUTES ?? 10);
    const A = ctx.avatar("A"), B = ctx.avatar("B");
    const T0 = Date.now();
    const file = path.join(here, "..", "recordings", `observe-humans-${new Date(T0).toISOString().replace(/:/g, "-")}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sink = fs.createWriteStream(file);
    const events = [];
    const names = new Map(), spaceUsers = new Map(); // userId -> name ; spaceUserId -> name
    const rel = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
    const rec = (e, say) => {
      const ev = { t: Date.now() - T0, ...e };
      events.push(ev); sink.write(JSON.stringify(ev) + "\n");
      if (say) ctx.log(`${rel()}s ${say}`);
      return ev;
    };
    const nameOf = (uid, c) => names.get(uid) ?? c?.players?.get(uid)?.name ?? `user${uid}`;

    await A.connect(); await B.connect();
    const ca = A.client, cb = B.client;
    const pit = (ca.areas ?? []).find((z) => /fire\s*pit/i.test(z.name));
    if (!pit) throw new Error("inconclusive: no Fire Pit area in this world");
    const rect = { x: pit.x, y: pit.y, w: pit.w, h: pit.h, name: pit.name };
    const meetingRects = (ca.areas ?? []).filter((z) => (z.rawProps ?? []).some((p) => p.type === "livekitRoomProperty"));
    const nav = ca.nav;
    if (!nav) throw new Error("inconclusive: no collision map");

    // Tap A: everything about the people around.
    const subA = ca._handleSub.bind(ca);
    ca._handleSub = (sub) => {
      const j = sub.userJoinedMessage;
      if (j) { names.set(j.userId, j.name ?? ""); if (!isProbe(j.name)) {
        rec({ kind: "userJoin", name: j.name }, `+ ${j.name} appeared`);
        rec({ kind: "pos", uid: j.userId, name: j.name, x: j.position?.x ?? 0, y: j.position?.y ?? 0, moving: !!j.position?.moving });
        if (j.availabilityStatus != null) rec({ kind: "status", uid: j.userId, name: j.name, status: statusName(j.availabilityStatus), initial: true });
      } }
      const m = sub.userMovedMessage;
      if (m?.position) { const n = nameOf(m.userId, ca); if (!isProbe(n)) rec({ kind: "pos", uid: m.userId, name: n, x: m.position.x ?? 0, y: m.position.y ?? 0, moving: !!m.position.moving }); }
      const l = sub.userLeftMessage;
      if (l) { const n = nameOf(l.userId, ca); if (!isProbe(n)) rec({ kind: "userLeft", name: n }, `- ${n} left`); }
      const d = sub.playerDetailsUpdatedMessage;
      if (d) {
        const n = nameOf(d.userId, ca);
        if (!isProbe(n)) {
          const s = d.details?.availabilityStatus;
          if (s != null) rec({ kind: "status", uid: d.userId, name: n, status: statusName(s) }, `STATUS ${n}: ${statusName(s)}`);
          const v = d.details?.setVariable;
          if (v) rec({ kind: "var", uid: d.userId, name: n, varName: v.name, value: String(v.value ?? "").replace(/^"|"$/g, "") }, v.name === "currentPlace" ? `PLACE ${n}: ${String(v.value).replace(/^"|"$/g, "")}` : undefined);
          if (s == null && !v) rec({ kind: "details", uid: d.userId, name: n, keys: Object.keys(d.details ?? {}) });
        }
      }
      const g = sub.groupUpdateMessage;
      if (g) rec({ kind: "group", gid: g.groupId, uids: g.userIds ?? [], names: (g.userIds ?? []).map((u) => nameOf(u, ca)), size: g.groupSize }, `BUBBLE ${g.groupId}: ${(g.userIds ?? []).map((u) => nameOf(u, ca)).join(", ")}`);
      const gd = sub.groupDeleteMessage;
      if (gd) rec({ kind: "groupDelete", gid: gd.groupId }, `BUBBLE ${gd.groupId} ended`);
      const em = sub.emoteEventMessage;
      if (em) { const n = nameOf(em.actorUserId, ca); if (!isProbe(n)) rec({ kind: "emote", name: n, emote: em.emote }, `MARK ${n}: ${em.emote}`); }
      return subA(sub);
    };
    // Tap B: space membership of the Fire Pit meeting.
    const subB = cb._handleSub.bind(cb);
    cb._handleSub = (sub) => {
      const i = sub.initSpaceUsersMessage;
      if (i) for (const u of i.users ?? []) { spaceUsers.set(u.spaceUserId, u.name); if (!isProbe(u.name)) rec({ kind: "spaceAdd", by: "B", spaceName: i.spaceName, name: u.name, initial: true }, `SPACE ${u.name} already in ${i.spaceName}`); }
      const a = sub.addSpaceUserMessage;
      if (a?.user) { spaceUsers.set(a.user.spaceUserId, a.user.name); if (!isProbe(a.user.name)) rec({ kind: "spaceAdd", by: "B", spaceName: a.spaceName, name: a.user.name }, `SPACE ${a.user.name} JOINED ${a.spaceName}`); }
      const r = sub.removeSpaceUserMessage;
      if (r) { const n = spaceUsers.get(r.spaceUserId) ?? r.spaceUserId; if (!isProbe(n)) rec({ kind: "spaceRemove", by: "B", spaceName: r.spaceName, name: n }, `SPACE ${n} LEFT ${r.spaceName}`); }
      return subB(sub);
    };
    for (const [w, tag] of [[A, "A"], [B, "B"]]) {
      const c = w.client;
      c.on("spaceJoined", ({ spaceName }) => rec({ kind: "own", who: tag, what: "joined space", spaceName }, `${tag} joined space ${spaceName}`));
      c.on("spaceLeft", ({ spaceName }) => rec({ kind: "own", who: tag, what: "left space", spaceName }, `${tag} left space ${spaceName}`));
      c.on("bubbleEntered", () => rec({ kind: "own", who: tag, what: "bubble in" }, `${tag} entered a proximity bubble`));
      c.on("bubbleLeft", () => rec({ kind: "own", who: tag, what: "bubble out" }, `${tag} left the proximity bubble`));
    }

    // Players already in view when we connected have no join message: seed their position and name.
    names.set(ca.myUserId, "wa-probe-a"); names.set(cb.myUserId, "wa-probe-b");
    for (const p of ca.listPlayers()) {
      names.set(p.userId, p.name ?? "");
      if (!isProbe(p.name)) rec({ kind: "pos", uid: p.userId, name: p.name, x: p.x ?? 0, y: p.y ?? 0, moving: false, initial: true }, `already here: ${p.name}`);
    }

    // Place B inside the Fire Pit (joins its meeting), A well outside every meeting area.
    const inB = B.openSpotInside(rect.x, rect.y, rect.w, rect.h);
    await cb.navTo(inB.x, inB.y, { stopWithin: 16, timeoutMs: 30000 });
    const farFromMeetings = (x, y) => rectDistance(x, y, rect) >= 250 && meetingRects.every((z) => rectDistance(x, y, z) >= 150);
    let spotA = null;
    for (const [dx, dy] of [[-300, 0], [-300, 150], [0, 420], [-250, -200], [0, -420], [450, 0]]) {
      const f = nav.nearestFree(...nav.pxToTile(rect.x + rect.w / 2 + dx - 0, rect.y + rect.h / 2 + dy));
      if (!f) continue;
      const [px, py] = nav.tileCenterPx(f[0], f[1]);
      if (farFromMeetings(px, py)) { spotA = { x: px, y: py }; break; }
    }
    if (!spotA) throw new Error("inconclusive: no spot for A outside the meeting areas");
    await ca.navTo(spotA.x, spotA.y, { stopWithin: 16, timeoutMs: 45000 });
    rec({ kind: "setup", pit: rect, spotA, spotB: inB, meetingAreas: meetingRects.map((z) => z.name) }, `setup: A at ${spotA.x | 0},${spotA.y | 0} (outside), B at ${inB.x | 0},${inB.y | 0} (inside the ${rect.name})`);

    let stop = false;
    const onStop = () => { stop = true; };
    process.on("SIGTERM", onStop); process.on("SIGINT", onStop);
    const banner = () => A.speechBubble(`observer, ${minutes} min. Loop: ${rect.name} → me → other player. 👍 = I heard a chime now, 😂 = that looked wrong`);
    banner();
    ctx.log(`observing for ${minutes} min (kill -TERM to stop early). Raw log: ${path.relative(process.cwd(), file)}`);
    const ticker = setInterval(banner, 60000);
    const end = T0 + minutes * 60000;
    while (!stop && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
    clearInterval(ticker);
    A.speechBubble("observer done, thanks!");
    await new Promise((r) => setTimeout(r, 1500));
    sink.end();

    const result = analyse(events, rect);
    if (!Object.keys(result).length) throw new Error("inconclusive: no other player was seen");
    return {
      observed: { pit: rect, durationS: Math.round((Date.now() - T0) / 1000), rawLog: path.relative(process.cwd(), file), players: result },
      verdict: "new",
      note: "observation, no pass/fail: read the per-player timings (entry vs status flip vs space join, speeds, flip distances to the area edge)",
    };
  },
};

// CLI: re-analyse a saved raw log.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === "--analyse") {
  const evs = fs.readFileSync(process.argv[3], "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const pit = evs.find((e) => e.kind === "setup")?.pit;
  console.log(JSON.stringify(analyse(evs, pit), null, 2));
}
