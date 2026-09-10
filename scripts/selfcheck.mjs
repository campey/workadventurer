// Smoke test for a version target: connect an ephemeral client (not the daemon),
// exercise the paths that depend on adapter values, print PASS/FAIL/SKIP per
// step. `wa selfcheck --target production` must stay green across any change.
//
//   node scripts/selfcheck.mjs [--target <id>] [--room <url>]

import { WorkAdventureClient } from "../src/wa-client.mjs";
import { resolveConfig } from "../src/config.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// "production" is a friendly alias for the auto-detected prod adapter.
const rawTarget = opt("target") ?? "auto";
const target = rawTarget === "production" ? "auto" : rawTarget;
const cfg = resolveConfig({ target, roomUrl: opt("room") });

let failed = false;
const line = (status, step, detail = "") => {
  if (status === "FAIL") failed = true;
  console.log(`${status.padEnd(4)}  ${step}${detail ? "  — " + detail : ""}`);
};

const client = new WorkAdventureClient({
  name: "selfcheck",
  roomUrl: cfg.roomUrl,
  pusherUrl: cfg.pusherUrl,
  target: cfg.target,
  version: cfg.version,
  wokaId: cfg.wokaId,
});

const errors = [];
client.on("error", (e) => errors.push(e.message));

try {
  // --- connect ---
  await Promise.race([
    client.connect(),
    new Promise((_, r) => setTimeout(() => r(new Error("15s timeout")), 15000)),
  ]);
  line("PASS", "connect + join", `userId ${client.myUserId}`);
  line("PASS", "adapter resolved", `${client.adapter.id} (${client.adapter.waVersion})`);

  // --- adapter match: a NEW_VERSION errorScreen would have landed in `errors` ---
  if (errors.some((m) => /version/i.test(m))) {
    line("FAIL", "apiVersionHash accepted", errors.find((m) => /version/i.test(m)));
  } else {
    line("PASS", "apiVersionHash accepted");
  }

  // --- move ---
  const before = { ...client.pos };
  await client.walkTo(before.x + 96, before.y, { stopWithin: 8, timeoutMs: 8000 });
  const moved = Math.hypot(client.pos.x - before.x, client.pos.y - before.y);
  line(moved > 64 ? "PASS" : "FAIL", "move", `moved ${moved.toFixed(0)}px`);

  // --- bubble ---
  try {
    client.speechBubble("selfcheck");
    client.clearBubble();
    line("PASS", "speech bubble set + clear");
  } catch (e) {
    line("FAIL", "speech bubble set + clear", e.message);
  }

  // --- area meeting (best-effort) ---
  const meetingArea = (client.areas ?? []).find((a) =>
    (a.rawProps ?? []).some((p) => p.type === "livekitRoomProperty")
  );
  if (!meetingArea) {
    line("SKIP", "area meeting join", "no livekitRoomProperty area on this map");
  } else {
    const joined = new Promise((res) => client.once("spaceJoined", res));
    await client.walkTo(
      meetingArea.x + meetingArea.w / 2,
      meetingArea.y + meetingArea.h / 2,
      { timeoutMs: 15000 }
    );
    const ok = await Promise.race([
      joined.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 8000)),
    ]);
    line(ok ? "PASS" : "FAIL", "area meeting join", `"${meetingArea.name}"`);
  }

  // --- audio (best-effort; needs a live peer) ---
  line("SKIP", "audio into meeting", "no second participant in an automated run");
} catch (e) {
  line("FAIL", "connect + join", e.message);
} finally {
  client.close();
  console.log(failed ? "\nFAIL" : "\nOK");
  process.exit(failed ? 1 : 0);
}
