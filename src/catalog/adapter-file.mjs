// Load a candidate adapter from a local file (--adapter-file / WA_ADAPTER_FILE / config
// `adapterFile`), so the gate can exercise an adapter that is not in the catalog yet.
// Fails loudly: an unreadable or invalid file throws, it never falls back to something else.

import { readFileSync } from "node:fs";
import { validateAdapterFile, buildAdapter } from "./schema.mjs";

/** The built adapter described by the file at `filePath`; throws a clear Error on any problem. */
export function loadAdapterFile(filePath, builtins) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`adapter file ${filePath}: cannot read it (${err.code || err.message})`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`adapter file ${filePath}: not valid JSON (${err.message})`);
  }
  const checked = validateAdapterFile(json, builtins);
  if (!checked.ok) throw new Error(`adapter file ${filePath}: invalid (${checked.reason})`);
  return buildAdapter(checked.file, builtins);
}
