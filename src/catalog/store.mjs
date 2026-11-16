// On-disk cache of downloaded adapter files, one <hash>.json per adapter. Writes
// are atomic (unique temp file in the same directory, then rename) so concurrent
// writers never corrupt each other; reads treat the file as hostile input and
// never throw, returning null for anything that does not validate.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { HASH_RE, buildAdapter, validateAdapterFile } from "./schema.mjs";

export const defaultCacheDir = () => join(homedir(), ".workadventurer", "adapters");

export async function saveCached(hash, text, { dir = defaultCacheDir() } = {}) {
  if (!HASH_RE.test(hash)) throw new Error(`invalid adapter hash "${hash}"`);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${hash}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, text);
    await rename(tmp, join(dir, `${hash}.json`));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** The built adapter cached under `hash`, or null if missing, unparsable, invalid or filed under the wrong hash. */
export async function loadCached(hash, { dir = defaultCacheDir(), builtins }) {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return null;
  try {
    const checked = validateAdapterFile(JSON.parse(await readFile(join(dir, `${hash}.json`), "utf8")), builtins);
    if (!checked.ok || checked.file.apiVersionHash !== hash) return null;
    return buildAdapter(checked.file, builtins);
  } catch {
    return null;
  }
}

export async function cachedHashes({ dir = defaultCacheDir() } = {}) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return new Set();
  }
  return new Set(names.filter((n) => n.endsWith(".json") && HASH_RE.test(n.slice(0, -5))).map((n) => n.slice(0, -5)));
}
