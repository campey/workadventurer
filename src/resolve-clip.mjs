// Resolve a `wa sound` argument to a file path: a bare name looks up a
// bundled clip in sounds/ (any format transcode.mjs can handle), anything
// with a path separator or an audio extension is treated as a path
// (absolute, or relative to the caller's cwd).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOUNDS_DIR = fileURLToPath(new URL("../sounds/", import.meta.url));

const BUNDLED_EXTS = ["ogg", "opus", "wav", "mp3", "m4a"];

export function resolveClip(nameOrPath, cwd) {
  if (/[/\\]|\.(ogg|opus|wav|mp3|m4a)$/i.test(nameOrPath)) {
    return path.resolve(cwd || process.cwd(), nameOrPath);
  }
  for (const ext of BUNDLED_EXTS) {
    const p = path.join(SOUNDS_DIR, `${nameOrPath}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return path.join(SOUNDS_DIR, `${nameOrPath}.ogg`);
}
