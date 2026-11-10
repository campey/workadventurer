// Reads WorkAdventure's /ws/room handshake contract out of IoSocketController.ts: the zod object that validates the
// websocket upgrade's query string. Which parameters are required and which optional is what a client must satisfy.

/** The /ws/room queryValidator: { required: Set, optional: Set } or null if not found. */
export function parseQueryValidator(ts) {
  // v1.31.1+: `queryValidator: z.object({...})` on the route; before that `validateWebsocketQuery(req, res, ctx, z.object({...}))`.
  let i = ts.indexOf("queryValidator");
  if (i < 0) i = ts.indexOf("validateWebsocketQuery(");
  if (i < 0) return null;
  const open = ts.indexOf("z.object({", i);
  if (open < 0) return null;
  let depth = 0, j = open + "z.object(".length;
  const start = j;
  for (; j < ts.length; j++) {
    if (ts[j] === "{") depth++;
    else if (ts[j] === "}") { depth--; if (depth === 0) break; }
  }
  const body = ts.slice(start + 1, j).replace(/\/\/[^\n]*/g, ""); // line comments sit between entries
  const required = new Set(), optional = new Set();
  // top-level `name: z.…,` entries; an entry may span lines, so split on commas at depth 0 of ( and [
  let cur = "", d = 0;
  const entries = [];
  for (const ch of body) {
    if ("([{".includes(ch)) d++;
    else if (")]}".includes(ch)) d--;
    if (ch === "," && d === 0) { entries.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) entries.push(cur);
  for (const e of entries) {
    const m = e.trim().match(/^(\w+)\s*:\s*([\s\S]*)$/);
    if (!m) continue;
    (/\.optional\(\)/.test(m[2]) ? optional : required).add(m[1]);
  }
  return { required, optional };
}

