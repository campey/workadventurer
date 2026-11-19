// Structural diff of two vendored WorkAdventure protos: what changed ON THE WIRE
// (field numbers, types, rules, oneof membership, removed messages/enums), not
// the text diff, which is mostly comments. Used to decide whether a new server
// release needs more than a new apiVersionHash.
//
//   node scripts/proto-diff.mjs proto/wa-1.33/messages.proto proto/wa-1.34/messages.proto [--all] [--scan src|android|both]
//
// Every wire-breaking item is checked against src/ (excluding src/adapters/) and
// the Android Kotlin sources (android/**/*.kt, not tests): "[USED by src/]" or
// "[USED by android/]" means that client mentions the name and the change needs a
// real look; otherwise it's a removal the client never touched.
// Exit code is 1 if any wire-breaking item is USED by a scanned client, else 0.
// `--scan` picks which clients count (default both). The adapter gate runs it
// against the Node proto family (--scan src) and against wa-1.33, the proto the
// Android app is built on (--scan android): additive changes only.
//
// What this cannot show: behaviour changes behind an unchanged shape. Verify
// those live with `wa selfcheck --target <adapter>`.

import fs from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Parse only — no resolveAll(): google.protobuf.* well-known types aren't loaded
// here and the comparison only needs the declared type names.
const load = (p) => {
  const root = new protobuf.Root();
  protobuf.parse(fs.readFileSync(p, "utf8"), root, { keepCase: true });
  return root;
};

const collect = (root) => {
  const types = new Map();
  const enums = new Map();
  const walk = (ns, prefix = "") => {
    for (const n of ns.nestedArray ?? []) {
      const full = prefix + n.name;
      if (n instanceof protobuf.Type) {
        types.set(full, n);
        walk(n, full + ".");
      } else if (n instanceof protobuf.Enum) enums.set(full, n);
      else if (n.nestedArray) walk(n, full + ".");
    }
  };
  walk(root);
  return { types, enums };
};

const sig = (f) =>
  `${f.rule ?? "singular"} ${f.type}${f.map ? "(map)" : ""}${f.partOf ? ` oneof:${f.partOf.name}` : ""}`;
const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);

/** The client sources a name is searched in: `src` (Node, no adapters/) and `android` (Kotlin, no tests). */
const walkFiles = (dir, keep, skipDir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return skipDir(e.name) ? [] : walkFiles(p, keep, skipDir);
    return keep(e.name) ? [p] : [];
  });

/** Texts of src/**.mjs (excluding src/adapters/). */
export function readNodeSources(root = repoRoot) {
  return walkFiles(path.join(root, "src"), (n) => n.endsWith(".mjs"), (n) => n === "adapters").map((p) => fs.readFileSync(p, "utf8"));
}

/** Texts of android/**.kt, excluding test and androidTest source sets and build output. */
export function readKotlinSources(root = repoRoot) {
  const dir = path.join(root, "android");
  if (!fs.existsSync(dir)) return [];
  return walkFiles(dir, (n) => n.endsWith(".kt"), (n) => ["build", ".gradle", "node_modules", "test", "androidTest"].includes(n)).map((p) => fs.readFileSync(p, "utf8"));
}

/**
 * Does Android use a wire-breaking item? Ruling R9: the message name AND (for a field or enum value) the
 * field name must co-occur in ONE Kotlin file (a bare `id` or `roomId` elsewhere proves nothing); a message
 * or enum on its own counts when any file names it. Either name may start in lower case. The backtest uses
 * this same function. `files` are Kotlin file texts; `it` is { msg, field? }.
 */
export function kotlinUses(files, it) {
  const word = (t, n) => new RegExp(`\\b${n}\\b`).test(t);
  return files.some((t) => (it.field
    ? word(t, it.msg) && (word(t, it.field) || word(t, lowerFirst(it.field)))
    : word(t, it.msg) || word(t, lowerFirst(it.msg))));
}

/**
 * Diff two proto files. `sources` is { src: string[], android: string[] } (texts); a client whose
 * list is missing is not scanned. Returns
 *   { counts, breaking: [{ text, usedBy: ["src"|"android"...] }], additive: string[], usedBy: Set }.
 */
export function diffProtos(oldPath, newPath, { sources = {} } = {}) {
  const a = collect(load(oldPath));
  const b = collect(load(newPath));
  const items = []; // { text, names[], parent?, oneof? }
  const additive = [];

  for (const [name, ta] of a.types) {
    const tb = b.types.get(name);
    const leaf = name.split(".").pop();
    if (!tb) {
      items.push({ text: `REMOVED message ${name}`, names: [leaf, lowerFirst(leaf)], msg: leaf });
      continue;
    }
    const fa = new Map(ta.fieldsArray.map((f) => [f.id, f]));
    const fb = new Map(tb.fieldsArray.map((f) => [f.id, f]));
    for (const [id, f] of fa) {
      const g = fb.get(id);
      // A plain field name (`id`, `name`, `spaceName`...) appears all over a client and
      // proves nothing on its own, so it only counts when its parent message is
      // referenced too. A oneof member (`queryMessage`, `joinRoomFrontMessage`...) is
      // different: that name is exactly what the client sends and switches on, so it
      // counts by itself.
      const parent = [leaf, lowerFirst(leaf)];
      if (!g) {
        items.push({ text: `REMOVED field ${name}.${f.name} = ${id} (${sig(f)})`, names: [f.name], parent, oneof: !!f.partOf, msg: leaf, field: f.name });
        continue;
      }
      if (g.name !== f.name)
        items.push({ text: `RENAMED ${name} field ${id}: ${f.name} -> ${g.name}`, names: [f.name, g.name], parent, oneof: !!f.partOf, msg: leaf, field: f.name });
      if (sig(f) !== sig(g))
        items.push({ text: `CHANGED ${name}.${f.name} = ${id}: [${sig(f)}] -> [${sig(g)}]`, names: [f.name], parent, oneof: !!f.partOf, msg: leaf, field: f.name });
    }
    for (const [id, g] of fb) if (!fa.has(id)) additive.push(`+ ${name}.${g.name} = ${id} (${sig(g)})`);
  }
  for (const name of b.types.keys()) if (!a.types.has(name)) additive.push(`+ message ${name}`);

  for (const [name, ea] of a.enums) {
    const eb = b.enums.get(name);
    if (!eb) {
      items.push({ text: `REMOVED enum ${name}`, names: [name.split(".").pop()], msg: name.split(".").pop() });
      continue;
    }
    for (const [k, v] of Object.entries(ea.values)) {
      if (!(k in eb.values)) items.push({ text: `REMOVED enum value ${name}.${k}=${v}`, names: [k], msg: name.split(".").pop(), field: k });
      else if (eb.values[k] !== v) items.push({ text: `CHANGED enum value ${name}.${k}: ${v} -> ${eb.values[k]}`, names: [k], msg: name.split(".").pop(), field: k });
    }
    for (const k of Object.keys(eb.values)) if (!(k in ea.values)) additive.push(`+ enum value ${name}.${k}=${eb.values[k]}`);
  }
  for (const name of b.enums.keys()) if (!a.enums.has(name)) additive.push(`+ enum ${name}`);

  const mentioned = (texts, names) => names.some((n) => { const re = new RegExp(`\\b${n}\\b`); return texts.some((t) => re.test(t)); });
  const isUsed = (texts, item) =>
    item.parent && !item.oneof ? mentioned(texts, item.parent) && mentioned(texts, item.names) : mentioned(texts, item.names);

  const usedBy = new Set();
  const breaking = items.map((item) => {
    const by = Object.entries(sources)
      .filter(([client, texts]) => (client === "android" && item.msg ? kotlinUses(texts, item) : isUsed(texts, item)))
      .map(([client]) => client);
    by.forEach((c) => usedBy.add(c));
    return { text: item.text, usedBy: by };
  });
  return {
    counts: { messagesOld: a.types.size, messagesNew: b.types.size, enumsOld: a.enums.size, enumsNew: b.enums.size },
    breaking,
    additive,
    usedBy,
  };
}

function main(args) {
  const [oldPath, newPath] = args.filter((x, i) => !x.startsWith("--") && args[i - 1] !== "--scan");
  const scanIdx = args.indexOf("--scan");
  const scan = scanIdx >= 0 ? args[scanIdx + 1] : "both";
  if (!oldPath || !newPath || !["src", "android", "both"].includes(scan)) {
    console.error("usage: node scripts/proto-diff.mjs <old.proto> <new.proto> [--all] [--scan src|android|both]");
    process.exit(2);
  }
  const sources = {};
  if (scan !== "android") sources.src = readNodeSources();
  if (scan !== "src") sources.android = readKotlinSources();
  const d = diffProtos(oldPath, newPath, { sources });
  const c = d.counts;
  console.log(`messages: ${c.messagesOld} -> ${c.messagesNew}   enums: ${c.enumsOld} -> ${c.enumsNew}`);
  console.log(`\n== WIRE-BREAKING (${d.breaking.length}) ==`);
  for (const item of d.breaking) console.log(`${item.usedBy.map((u) => `[USED by ${u}/] `).join("")}${item.text}`);
  console.log(`\n== ADDITIVE (${d.additive.length}) ==`);
  if (args.includes("--all")) d.additive.forEach((l) => console.log(l));
  else console.log("(pass --all to list)");
  const who = [...d.usedBy].map((u) => `${u}/`).join(" and ");
  console.log(d.usedBy.size ? `\nA wire-breaking change is USED by ${who} — a hash bump alone is not enough.` : `\nNo wire-breaking change is referenced by ${scan === "both" ? "src/ or android/" : scan + "/"}.`);
  process.exit(d.usedBy.size ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
