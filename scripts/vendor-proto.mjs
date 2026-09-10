// Vendor WorkAdventure's proto for a given git ref and compute its
// apiVersionHash, so an adapter can be pinned to a build.
//
//   node scripts/vendor-proto.mjs v1.33.5 wa-1.33
//   node scripts/vendor-proto.mjs master  wa-master
//   node scripts/vendor-proto.mjs --check v1.33.5      # just recompute + print, don't write
//
// Uses the GitHub API (no git clone). Unauthenticated is 60 req/hr — set
// GITHUB_TOKEN to raise it. Mirrors WorkAdventure's own recipe
// (messages/package.json "tag-version"):
//   sha1sum protos/messages.proto ../libs/messages/src/JsonMessages/* | sha1sum | cut -c1-8

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = "workadventure/workadventure";
const argv = process.argv.slice(2);
const check = argv.includes("--check");
const [ref, nameArg] = argv.filter((a) => a !== "--check");
if (!ref) {
  console.error("usage: node scripts/vendor-proto.mjs [--check] <git-ref> [name]");
  process.exit(2);
}
const name = nameArg || ref.replace(/[^A-Za-z0-9._-]/g, "-");
const root = fileURLToPath(new URL("..", import.meta.url));

const gh = (url) =>
  fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "workadventurer-vendor-proto",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`GET ${url} → ${r.status} ${await r.text().catch(() => "")}`);
    return r;
  });

const raw = (p) =>
  gh(`https://raw.githubusercontent.com/${REPO}/${ref}/${p}`).then((r) => r.arrayBuffer());

const sha1 = (buf) => crypto.createHash("sha1").update(Buffer.from(buf)).digest("hex");

// --- resolve the ref to a concrete commit sha ---
const commit = await gh(`https://api.github.com/repos/${REPO}/commits/${ref}`).then((r) => r.json());
const fullSha = commit.sha;
const shortSha = fullSha.slice(0, 8);
console.error(`ref ${ref} → ${shortSha}`);

// --- list JsonMessages/, download it + messages.proto ---
const listing = await gh(
  `https://api.github.com/repos/${REPO}/contents/libs/messages/src/JsonMessages?ref=${ref}`
).then((r) => r.json());
const jsonFiles = listing
  .filter((e) => e.type === "file")
  .map((e) => e.name)
  .sort();

const protoPath = "messages/protos/messages.proto";
const protoBuf = await raw(protoPath);
const jsonBufs = {};
for (const f of jsonFiles) jsonBufs[f] = await raw(`libs/messages/src/JsonMessages/${f}`);

// --- replicate `sha1sum protos/messages.proto ../libs/messages/src/JsonMessages/* | sha1sum` ---
// Run from messages/, so paths print as `protos/...` and `../libs/messages/src/JsonMessages/...`.
const lines = [
  `${sha1(protoBuf)}  protos/messages.proto`,
  ...jsonFiles.map((f) => `${sha1(jsonBufs[f])}  ../libs/messages/src/JsonMessages/${f}`),
];
const inner = lines.join("\n") + "\n";
const apiVersionHash = sha1(Buffer.from(inner)).slice(0, 8);

console.log(`apiVersionHash: ${apiVersionHash}`);

if (check) process.exit(0);

// --- write proto/<name>/messages.proto + SOURCE ---
const outDir = path.join(root, "proto", name);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "messages.proto"), Buffer.from(protoBuf));
writeFileSync(
  path.join(outDir, "SOURCE"),
  `repo: ${REPO}\nref: ${ref}\nsha: ${fullSha}\nshortSha: ${shortSha}\n` +
    `vendored: ${new Date().toISOString()}\napiVersionHash: ${apiVersionHash}\n` +
    `jsonMessages: ${jsonFiles.length} files\n`
);

console.log(`\nwrote proto/${name}/messages.proto  (+ SOURCE)`);
console.log(`→ set adapters/${name}.mjs  apiVersionHashes: ["${apiVersionHash}"]  trackedSha: "${shortSha}"`);
