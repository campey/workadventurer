// Backtest: across WorkAdventure's release history (and its development branches), when would a data-only
// adapter (a new API hash laid over an existing protocol family) have been insufficient?
//
//   node scripts/adapter-backtest.mjs [--from v1.20.0] [--refs develop,master] [--out report.json]
//
// For each upstream ref (every release tag from --from, plus the given branches) it fetches, from raw.githubusercontent.com:
//   - messages/protos/messages.proto              the wire protocol
//   - IoSocketController.ts                       its `queryValidator: z.object({...})` is the /ws/room handshake contract
// and compares each ref with the previous one:
//   - proto: wire-breaking items (via scripts/proto-diff.mjs), how many the Node client uses (`[USED by src/]`) and how
//     many the Android client mentions (a name search in android/**/*.kt)
//   - handshake: query parameters that are new or newly required (a client written for the previous release would not
//     send them); parameters removed are listed but harmless
// A ref is flagged "insufficient" when the protocol changed in a way a client uses, or the handshake gained a new/newly required
// parameter. Anything else with a changed hash is "hash-only": absorbable by a data adapter.
// It does NOT see behaviour changes behind an unchanged message shape (those need the live scenarios).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseQueryValidator } from "./lib/query-validator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const FROM = opt("from", "v1.20.0");
const BRANCHES = (opt("refs", "develop,master") || "").split(",").filter(Boolean);
const OUT = opt("out", null);
const REPO = "workadventure/workadventure";
const RAW = `https://raw.githubusercontent.com/${REPO}`;

const IO_PATHS = [
  "play/src/pusher/controllers/IoSocketController.ts",
  "pusher/src/Controller/IoSocketController.ts",
  "pusher/src/controllers/IoSocketController.ts",
];

const cmpVer = (a, b) => {
  const x = a.slice(1).split(".").map(Number), y = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

function listTags() {
  const out = execFileSync("git", ["ls-remote", "--tags", `https://github.com/${REPO}`], { encoding: "utf8" });
  return [...out.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)$/gm)].map((m) => m[1])
    .filter((t) => cmpVer(t, FROM) >= 0).sort(cmpVer);
}

async function get(ref, file) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${RAW}/${ref}/${file}`, { signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;
      if (r.ok) return await r.text();
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return null;
}

// A wire-breaking item matters to Android only if a Kotlin file mentions its message AND (for a field) the field name
// together; a bare field name like `id` or `roomId` appears everywhere and proves nothing.
let kotlinFiles = null;
function androidMentions(items) {
  if (!kotlinFiles) {
    const files = execFileSync("git", ["ls-files", "android/**/*.kt"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    kotlinFiles = files.filter((f) => !/\/(test|androidTest)\//.test(f)).map((f) => fs.readFileSync(path.join(root, f), "utf8"));
  }
  const word = (t, n) => new RegExp(`\\b${n}\\b`).test(t);
  const lc = (n) => n.charAt(0).toLowerCase() + n.slice(1);
  const hits = [];
  for (const it of items) {
    const ok = kotlinFiles.some((t) => (it.field
      ? (word(t, it.msg) && (word(t, it.field) || word(t, lc(it.field))))
      : (word(t, it.msg) || word(t, lc(it.msg)))));
    if (ok) hits.push(it.field ? `${it.msg}.${it.field}` : it.msg);
  }
  return hits;
}

function protoDiff(prevFile, curFile) {
  const r = spawnSync("node", [path.join(root, "scripts/proto-diff.mjs"), prevFile, curFile], { cwd: root, encoding: "utf8" });
  const out = r.stdout || "";
  const wb = out.match(/== WIRE-BREAKING \((\d+)\)/);
  const lines = out.split("\n").filter((l) => /^(REMOVED|CHANGED|RENUMBERED|RETYPED|MOVED)/.test(l));
  const usedNode = lines.filter((l) => l.includes("[USED by src/]"));
  const items = [];
  for (const l of lines) {
    const m = l.match(/^\w+ (?:field|message|enum value|enum)\s+([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?/);
    if (m) items.push(m[2] ? { msg: m[1], field: m[2] } : { msg: m[1] });
  }
  return { wireBreaking: wb ? Number(wb[1]) : 0, usedNode: usedNode.map((l) => l.replace(" [USED by src/]", "")), items, sample: lines };
}

const tags = listTags();
const refs = [...tags, ...BRANCHES];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backtest-"));
const data = new Map();
let next = 0;
async function worker() {
  while (next < refs.length) {
    const ref = refs[next++];
    const proto = await get(ref, "messages/protos/messages.proto");
    let io = null;
    for (const p of IO_PATHS) { io = await get(ref, p); if (io) break; }
    if (proto) fs.writeFileSync(path.join(tmp, `${ref.replace(/\W/g, "_")}.proto`), proto);
    data.set(ref, { proto, io: io ? parseQueryValidator(io) : null, ioFound: !!io });
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

const rows = [];
let prev = null;
let lastTag = null; // branches are compared with the newest release tag, not with each other
for (const ref of refs) {
  const isBranch = BRANCHES.includes(ref);
  if (isBranch) prev = lastTag;
  const cur = data.get(ref);
  if (!cur.proto) { rows.push({ ref, missing: true }); continue; }
  const row = { ref, protoChanged: false, wireBreaking: 0, usedNode: [], androidUsed: [], newRequired: [], removedParams: [], verdict: "same" };
  if (prev) {
    const same = cur.proto === prev.proto;
    row.protoChanged = !same;
    if (!same) {
      const d = protoDiff(path.join(tmp, `${prev.ref.replace(/\W/g, "_")}.proto`), path.join(tmp, `${ref.replace(/\W/g, "_")}.proto`));
      row.wireBreaking = d.wireBreaking;
      row.usedNode = d.usedNode;
      row.androidUsed = androidMentions(d.items);
      row.sample = d.sample;
    }
    if (cur.io && prev.io) {
      // A client written for the previous release sends what the previous contract knew. So a parameter the previous
      // contract did not mention, or that was optional and is now required, breaks it.
      const knewBefore = new Set([...prev.io.required, ...prev.io.optional]);
      row.newRequired = [...cur.io.required].filter((p) => !knewBefore.has(p));
      row.madeRequired = [...cur.io.required].filter((p) => prev.io.optional.has(p));
      row.removedParams = [...prev.io.required, ...prev.io.optional].filter((p) => !cur.io.required.has(p) && !cur.io.optional.has(p));
    }
    row.ioUnknown = !cur.io || !prev.io;
    row.verdict = row.usedNode.length || row.androidUsed.length || row.newRequired.length || row.madeRequired?.length
      ? "INSUFFICIENT"
      : row.protoChanged ? "proto-additive-or-unused" : "same-proto";
  }
  rows.push(row);
  prev = { ref, proto: cur.proto, io: cur.io };
  if (!isBranch) lastTag = prev;
}
fs.rmSync(tmp, { recursive: true, force: true });

const flagged = rows.filter((r) => r.verdict === "INSUFFICIENT");
console.log(`${rows.length} refs from ${FROM} (+ ${BRANCHES.join(", ") || "no branches"}); proto changed in ${rows.filter((r) => r.protoChanged).length}; handshake unreadable in ${rows.filter((r) => r.ioUnknown).length}`);
console.log(`INSUFFICIENT for a data adapter: ${flagged.length}`);
for (const r of flagged) {
  console.log(`  ${r.ref}: ${[
    r.usedNode.length ? `Node uses ${r.usedNode.length} wire-breaking item(s): ${r.usedNode.slice(0, 3).join(" | ")}` : "",
    r.androidUsed.length ? `Android mentions: ${r.androidUsed.slice(0, 6).join(", ")}` : "",
    r.newRequired.length ? `new REQUIRED handshake param(s): ${r.newRequired.join(", ")}` : "",
    r.madeRequired?.length ? `handshake param(s) made required: ${r.madeRequired.join(", ")}` : "",
  ].filter(Boolean).join("; ")}`);
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
