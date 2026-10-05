// Structural diff of two vendored WorkAdventure protos: what changed ON THE WIRE
// (field numbers, types, rules, oneof membership, removed messages/enums), not
// the text diff, which is mostly comments. Used to decide whether a new server
// release needs more than a new apiVersionHash.
//
//   node scripts/proto-diff.mjs proto/wa-1.33/messages.proto proto/wa-1.34/messages.proto [--all]
//
// Every wire-breaking item is checked against src/ (excluding src/adapters/):
// "[USED by src/]" means the client mentions that name and the change needs a
// real look; otherwise it's a removal the client never touched.
// Exit code is 1 if any wire-breaking item is USED by src/, else 0.
//
// What this cannot show: behaviour changes behind an unchanged shape. Verify
// those live with `wa selfcheck --target <adapter>`.

import fs from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const [oldPath, newPath] = args.filter((a) => !a.startsWith("--"));
if (!oldPath || !newPath) {
  console.error("usage: node scripts/proto-diff.mjs <old.proto> <new.proto> [--all]");
  process.exit(2);
}

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

const a = collect(load(oldPath));
const b = collect(load(newPath));
const breaking = []; // { text, names[] }
const additive = [];
const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);

for (const [name, ta] of a.types) {
  const tb = b.types.get(name);
  const leaf = name.split(".").pop();
  if (!tb) {
    breaking.push({ text: `REMOVED message ${name}`, names: [leaf, lowerFirst(leaf)] });
    continue;
  }
  const fa = new Map(ta.fieldsArray.map((f) => [f.id, f]));
  const fb = new Map(tb.fieldsArray.map((f) => [f.id, f]));
  for (const [id, f] of fa) {
    const g = fb.get(id);
    // A plain field name (`id`, `name`, `spaceName`...) appears all over src/ and
    // proves nothing on its own, so it only counts when its parent message is
    // referenced too. A oneof member (`queryMessage`, `joinRoomFrontMessage`...) is
    // different: that name is exactly what the client sends and switches on, so it
    // counts by itself.
    const parent = [leaf, lowerFirst(leaf)];
    if (!g) {
      breaking.push({
        text: `REMOVED field ${name}.${f.name} = ${id} (${sig(f)})`,
        names: [f.name],
        parent,
        oneof: !!f.partOf,
      });
      continue;
    }
    if (g.name !== f.name)
      breaking.push({ text: `RENAMED ${name} field ${id}: ${f.name} -> ${g.name}`, names: [f.name, g.name], parent, oneof: !!f.partOf });
    if (sig(f) !== sig(g))
      breaking.push({
        text: `CHANGED ${name}.${f.name} = ${id}: [${sig(f)}] -> [${sig(g)}]`,
        names: [f.name],
        parent,
        oneof: !!f.partOf,
      });
  }
  for (const [id, g] of fb) if (!fa.has(id)) additive.push(`+ ${name}.${g.name} = ${id} (${sig(g)})`);
}
for (const name of b.types.keys()) if (!a.types.has(name)) additive.push(`+ message ${name}`);

for (const [name, ea] of a.enums) {
  const eb = b.enums.get(name);
  if (!eb) {
    breaking.push({ text: `REMOVED enum ${name}`, names: [name.split(".").pop()] });
    continue;
  }
  for (const [k, v] of Object.entries(ea.values)) {
    if (!(k in eb.values)) breaking.push({ text: `REMOVED enum value ${name}.${k}=${v}`, names: [k] });
    else if (eb.values[k] !== v)
      breaking.push({ text: `CHANGED enum value ${name}.${k}: ${v} -> ${eb.values[k]}`, names: [k] });
  }
  for (const k of Object.keys(eb.values)) if (!(k in ea.values)) additive.push(`+ enum value ${name}.${k}=${eb.values[k]}`);
}
for (const name of b.enums.keys()) if (!a.enums.has(name)) additive.push(`+ enum ${name}`);

// --- which of the breaking names does the client mention? ---
const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const readTree = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "adapters" ? [] : readTree(p);
    return e.name.endsWith(".mjs") ? [fs.readFileSync(p, "utf8")] : [];
  });
const source = readTree(srcRoot).join("\n");
const mentioned = (names) => names.some((n) => new RegExp(`\\b${n}\\b`).test(source));
const used = (item) =>
  item.parent && !item.oneof ? mentioned(item.parent) && mentioned(item.names) : mentioned(item.names);

console.log(`messages: ${a.types.size} -> ${b.types.size}   enums: ${a.enums.size} -> ${b.enums.size}`);
console.log(`\n== WIRE-BREAKING (${breaking.length}) ==`);
let anyUsed = false;
for (const item of breaking) {
  const u = used(item);
  anyUsed ||= u;
  console.log(`${u ? "[USED by src/] " : ""}${item.text}`);
}
console.log(`\n== ADDITIVE (${additive.length}) ==`);
if (args.includes("--all")) additive.forEach((l) => console.log(l));
else console.log("(pass --all to list)");
console.log(
  anyUsed
    ? "\nA wire-breaking change is USED by src/ — a hash bump alone is not enough."
    : "\nNo wire-breaking change is referenced by src/."
);
process.exit(anyUsed ? 1 : 0);
