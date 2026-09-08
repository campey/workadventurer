// Grid pathfinding over the baked collision map (map/collision.json).
// A* on an 8-connected tile grid, then line-of-sight smoothing so the avatar
// walks natural diagonals instead of tile-center staircases.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Areas whose name marks an enclosed room you shouldn't barge into. */
const DEFAULT_ROOM_RE = /board\s*room/i;

export class MapNav {
  constructor(json) {
    this.w = json.width;
    this.h = json.height;
    this.tile = json.tile;
    this.blocked = new Uint8Array(this.w * this.h);
    for (const i of json.blocked) this.blocked[i] = 1;
    this.startTiles = json.start ?? [];
    this.areas = json.areas ?? [];
  }

  /** A random spawn point (pixel centre of a `start` tile), or null. */
  randomSpawnPx() {
    if (!this.startTiles.length) return null;
    const idx = this.startTiles[(Math.random() * this.startTiles.length) | 0];
    return this.tileCenterPx(idx % this.w, (idx / this.w) | 0);
  }

  /** The enclosed room area containing (px,py), or null. */
  roomAt(px, py, roomRe = DEFAULT_ROOM_RE) {
    for (const a of this.areas) {
      if (!roomRe.test(a.name)) continue;
      if (px >= a.x && px < a.x + a.w && py >= a.y && py < a.y + a.h) return a;
    }
    return null;
  }

  _rectContains(a, px, py, pad = 0) {
    return px >= a.x - pad && px < a.x + a.w + pad && py >= a.y - pad && py < a.y + a.h + pad;
  }

  /**
   * A reachable free point just OUTSIDE `room`, as close as possible to
   * (targetX,targetY) — i.e. "wait by the door". `reachable(px,py)` should
   * return true if we can path there from where we are.
   */
  pointOutsideRoom(room, targetX, targetY, reachable) {
    const T = this.tile;
    const candidates = [];
    // ring of tiles from just outside the room wall outward
    for (let ring = 1; ring <= 6; ring++) {
      const x0 = Math.floor((room.x) / T) - ring;
      const x1 = Math.floor((room.x + room.w) / T) + ring;
      const y0 = Math.floor((room.y) / T) - ring;
      const y1 = Math.floor((room.y + room.h) / T) + ring;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const onRing = tx === x0 || tx === x1 || ty === y0 || ty === y1;
          if (!onRing || this.isTileBlocked(tx, ty)) continue;
          const [cx, cy] = this.tileCenterPx(tx, ty);
          if (this._rectContains(room, cx, cy)) continue; // still inside
          candidates.push([cx, cy, (cx - targetX) ** 2 + (cy - targetY) ** 2]);
        }
      }
      if (candidates.length) break; // nearest ring with any free tile wins
    }
    candidates.sort((a, b) => a[2] - b[2]);
    for (const [cx, cy] of candidates.slice(0, 12)) {
      if (!reachable || reachable(cx, cy)) return [cx, cy];
    }
    return candidates.length ? [candidates[0][0], candidates[0][1]] : null;
  }

  static load(file = path.join(__dirname, "..", "map", "collision.json")) {
    return new MapNav(JSON.parse(fs.readFileSync(file, "utf8")));
  }

  _idx(tx, ty) {
    return ty * this.w + tx;
  }

  inBounds(tx, ty) {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }

  isTileBlocked(tx, ty) {
    return !this.inBounds(tx, ty) || this.blocked[this._idx(tx, ty)] === 1;
  }

  pxToTile(px, py) {
    return [Math.floor(px / this.tile), Math.floor(py / this.tile)];
  }

  tileCenterPx(tx, ty) {
    return [tx * this.tile + this.tile / 2, ty * this.tile + this.tile / 2];
  }

  isPxBlocked(px, py) {
    const [tx, ty] = this.pxToTile(px, py);
    return this.isTileBlocked(tx, ty);
  }

  /** Nearest free tile to (tx,ty), spiralling outward. */
  nearestFree(tx, ty, maxR = 40) {
    if (!this.isTileBlocked(tx, ty)) return [tx, ty];
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (!this.isTileBlocked(tx + dx, ty + dy)) return [tx + dx, ty + dy];
        }
      }
    }
    return null;
  }

  /** True if a straight line between two tile centers stays on free tiles. */
  _lineClear(ax, ay, bx, by) {
    let x0 = ax;
    let y0 = ay;
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      if (this.isTileBlocked(x0, y0)) return false;
      // block diagonal corner-cutting
      if (x0 !== bx && y0 !== by) {
        if (this.isTileBlocked(x0 + sx, y0) && this.isTileBlocked(x0, y0 + sy)) return false;
      }
      if (x0 === bx && y0 === by) return true;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dy === 0 ? 0 : dx; y0 += sy; }
    }
  }

  /**
   * Pixel-space path from (fromPx) to (toPx) as a list of [x,y] waypoints
   * (tile centers, smoothed). Returns null if unreachable.
   * Start/goal are snapped to the nearest free tile.
   */
  findPath(fromX, fromY, toX, toY) {
    let [sx, sy] = this.pxToTile(fromX, fromY);
    let [gx, gy] = this.pxToTile(toX, toY);
    const s = this.nearestFree(sx, sy);
    const g = this.nearestFree(gx, gy);
    if (!s || !g) return null;
    [sx, sy] = s;
    [gx, gy] = g;
    if (sx === gx && sy === gy) return [this.tileCenterPx(gx, gy)];

    const N = this.w * this.h;
    const came = new Int32Array(N).fill(-1);
    const gScore = new Float64Array(N).fill(Infinity);
    const start = this._idx(sx, sy);
    const goal = this._idx(gx, gy);
    gScore[start] = 0;

    const h = (i) => {
      const x = i % this.w;
      const y = (i / this.w) | 0;
      const dx = Math.abs(x - gx);
      const dy = Math.abs(y - gy);
      return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy); // octile
    };

    // binary heap
    const heap = [];
    const push = (i, f) => {
      heap.push([f, i]);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (heap[p][0] <= heap[c][0]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]];
        c = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let p = 0;
        for (;;) {
          const l = 2 * p + 1;
          const r = l + 1;
          let m = p;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === p) break;
          [heap[m], heap[p]] = [heap[p], heap[m]];
          p = m;
        }
      }
      return top;
    };

    push(start, h(start));
    const DIRS = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];

    while (heap.length) {
      const [, cur] = pop();
      if (cur === goal) break;
      const cx = cur % this.w;
      const cy = (cur / this.w) | 0;
      for (const [dx, dy, cost] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (this.isTileBlocked(nx, ny)) continue;
        if (dx !== 0 && dy !== 0) {
          if (this.isTileBlocked(cx + dx, cy) || this.isTileBlocked(cx, cy + dy)) continue; // no corner cut
        }
        const ni = this._idx(nx, ny);
        const ng = gScore[cur] + cost;
        if (ng < gScore[ni]) {
          gScore[ni] = ng;
          came[ni] = cur;
          push(ni, ng + h(ni));
        }
      }
    }

    if (came[goal] === -1 && goal !== start) return null;

    // reconstruct tile path
    const tiles = [];
    for (let i = goal; i !== -1; i = came[i]) {
      tiles.push([i % this.w, (i / this.w) | 0]);
      if (i === start) break;
    }
    tiles.reverse();

    // line-of-sight smoothing
    const smooth = [tiles[0]];
    let anchor = 0;
    for (let i = 2; i < tiles.length; i++) {
      const [ax, ay] = tiles[anchor];
      const [cx, cy] = tiles[i];
      if (!this._lineClear(ax, ay, cx, cy)) {
        smooth.push(tiles[i - 1]);
        anchor = i - 1;
      }
    }
    smooth.push(tiles[tiles.length - 1]);

    return smooth.map(([tx, ty]) => this.tileCenterPx(tx, ty));
  }
}
