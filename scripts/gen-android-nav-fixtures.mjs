// Generates test fixtures for android/nav from the Node implementation, so the Kotlin A* can be
// checked for exact parity with src/map-nav.mjs. Run from the repo root: node scripts/gen-android-nav-fixtures.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MapNav } from "../src/map-nav.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "map/afrolabs/afrolabs/open-space/collision.json");
const outDir = path.join(root, "android/nav/src/test/resources");
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, path.join(outDir, "afrolabs-collision.json"));

const nav = MapNav.load(src);
const W = nav.w * nav.tile;
const H = nav.h * nav.tile;
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pt = () => [Math.round(rnd() * W), Math.round(rnd() * H)];

const cases = [];
for (let i = 0; i < 40; i++) {
  const from = pt();
  const to = pt();
  cases.push({ from, to, path: nav.findPath(from[0], from[1], to[0], to[1]) });
}
// every start tile -> every named area centre
for (const s of nav.startTiles.slice(0, 2)) {
  const from = nav.tileCenterPx(s % nav.w, (s / nav.w) | 0);
  for (const a of nav.areas) {
    const to = [Math.round(a.x + a.w / 2), Math.round(a.y + a.h / 2)];
    cases.push({ from, to, path: nav.findPath(from[0], from[1], to[0], to[1]) });
  }
}
fs.writeFileSync(path.join(outDir, "afrolabs-paths.json"), JSON.stringify(cases));
console.log(`wrote ${cases.length} cases (${cases.filter((c) => !c.path).length} unreachable) to ${outDir}`);
