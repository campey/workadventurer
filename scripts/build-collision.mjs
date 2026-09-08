// Build a compact map-data file for the afrolabs open-space map.
//
// WorkAdventure's own pathfinding reads the Tiled map; we do the same, offline,
// and bake the result to map/collision.json so the client doesn't parse a 1.3 MB
// .tmj at runtime. The file also carries the spawn tiles and the named areas.
//
//   node scripts/build-collision.mjs
//
// Sources of "blocked":
//   1. the dedicated `collisions` tile layer (any non-zero cell)
//   2. tiles whose tileset entry has `collides: true` (only a couple on this map)
//   3. furniture entities placed in the .wam (chairs, stools, tables)
//
// Plus:
//   start  - tile indices of the `start` layer (WorkAdventure's default spawn)
//   areas  - named rectangles from the .wam (rooms, benches, tables, ...)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WAM_URL = "https://afrolabs-16156.map-storage.workadventu.re/open-space.wam";

const flattenLayers = function* (layers) {
  for (const l of layers) {
    if (l.type === "group") yield* flattenLayers(l.layers);
    else yield l;
  }
};

async function main() {
  const wam = await (await fetch(WAM_URL)).json();
  const tmj = await (await fetch(wam.mapUrl)).json();

  const W = tmj.width;
  const H = tmj.height;
  const TILE = tmj.tilewidth;
  const blocked = new Uint8Array(W * H);

  const layers = Object.fromEntries([...flattenLayers(tmj.layers)].map((l) => [l.name, l]));

  // (1) explicit collisions layer
  const col = layers["collisions"];
  if (col?.data) {
    for (let i = 0; i < col.data.length; i++) if (col.data[i] !== 0) blocked[i] = 1;
  }

  // (2) gids of tiles flagged `collides: true` in any tileset
  const collidesGids = new Set();
  for (const ts of tmj.tilesets) {
    for (const td of ts.tiles ?? []) {
      const p = (td.properties ?? []).find((x) => x.name === "collides");
      if (p && (p.value === true || p.value === "true")) collidesGids.add(ts.firstgid + td.id);
    }
  }
  if (collidesGids.size) {
    for (const l of flattenLayers(tmj.layers)) {
      if (l.type !== "tilelayer" || !l.data) continue;
      for (let i = 0; i < l.data.length; i++) {
        // strip Tiled flip flags in the high bits
        const gid = l.data[i] & 0x1fffffff;
        if (gid && collidesGids.has(gid)) blocked[i] = 1;
      }
    }
  }

  // (3) .wam furniture entities — block the tile under the entity's centre and,
  // for anything bigger than a stool, a small footprint around it.
  let entityCells = 0;
  for (const ent of Object.values(wam.entities ?? {})) {
    const id = (ent.prefabRef?.id ?? "").toLowerCase();
    const big = !/(stool|chair)/.test(id); // tables, plants, counters, etc.
    const cx = Math.floor((ent.x + TILE / 2) / TILE);
    const cy = Math.floor((ent.y + TILE / 2) / TILE);
    const r = big ? 1 : 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < W && y < H && !blocked[y * W + x]) {
          blocked[y * W + x] = 1;
          entityCells++;
        }
      }
    }
  }

  // Pack as a run-length list of blocked tile indices (small: ~1k cells).
  const indices = [];
  for (let i = 0; i < blocked.length; i++) if (blocked[i]) indices.push(i);

  // Spawn: non-zero tiles of the `start` layer (WorkAdventure's default entry).
  const start = [];
  const startLayer = layers["start"];
  if (startLayer?.data) {
    for (let i = 0; i < startLayer.data.length; i++) if (startLayer.data[i] !== 0) start.push(i);
  }

  // Named areas from the .wam — rooms, seating, tables. Keep the named ones.
  const areas = (wam.areas ?? [])
    .filter((a) => a.name)
    .map((a) => ({
      name: a.name,
      x: Math.round(a.x),
      y: Math.round(a.y),
      w: Math.round(a.width),
      h: Math.round(a.height),
    }));

  const out = {
    source: { wam: WAM_URL, map: wam.mapUrl },
    width: W,
    height: H,
    tile: TILE,
    blocked: indices,
    start,
    areas,
  };
  const dest = path.join(__dirname, "..", "map", "collision.json");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, JSON.stringify(out));
  console.log(
    `wrote ${dest}: ${W}x${H} tiles, ${indices.length} blocked ` +
      `(${entityCells} from ${Object.keys(wam.entities ?? {}).length} entities), ` +
      `${start.length} spawn tiles, ${areas.length} named areas`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
