// Downloadable adapter files: strict, data-only validation and the builder that
// lays a catalog file over a built-in adapter (its protoFamily). A file can carry
// a version hash, two meeting debounce numbers, two walking speeds and a few extra
// handshake query parameters; nothing else survives validation, and nothing that
// looks like code is ever accepted. See the plan's Global Constraints.

export const HASH_RE = /^[0-9a-f]{8}$/;
export const BOUNDS = { dwellMs: [0, 10000], lingerMs: [0, 10000], speed: [50, 1000] };

const SERVERS = ["production", "staging"];
const NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const VALUE_RE = /^[A-Za-z0-9._:{}-]{0,64}$/;
const PLACEHOLDERS = new Set(["{tabId}", "{uuid}"]);
const FORBIDDEN = new Set(["roomId", "version", "characterTextureIds", "token"]);
const MAX_PARAMS = 12;
const LABEL_RE = /^[A-Za-z0-9._-]{1,32}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const inRange = (v, [lo, hi]) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const bad = (reason) => ({ ok: false, reason });

function checkHandshake(h) {
  if (!isObj(h) || !isObj(h.query)) return { reason: "handshake.query must be an object" };
  const names = Object.keys(h.query);
  if (names.length > MAX_PARAMS) return { reason: `handshake.query has more than ${MAX_PARAMS} parameters` };
  const query = {};
  for (const name of names) {
    if (FORBIDDEN.has(name)) return { reason: `handshake.query.${name} is forbidden` };
    if (!NAME_RE.test(name)) return { reason: `handshake.query name "${name}" is invalid` };
    const value = h.query[name];
    if (typeof value !== "string" || !VALUE_RE.test(value)) {
      return { reason: `handshake.query.${name} value is invalid` };
    }
    const braces = value.match(/\{[^{}]*\}|[{}]/g) ?? [];
    if (braces.some((p) => !PLACEHOLDERS.has(p))) {
      return { reason: `handshake.query.${name} has an unknown placeholder` };
    }
    query[name] = value;
  }
  return { query };
}

/** Check an adapter file (already JSON-parsed); returns the normalised file, whitelisted fields only. */
export function validateAdapterFile(file, builtins) {
  if (!isObj(file)) return bad("file must be an object");
  if (file.schema !== 1) return bad("schema must be 1");
  if (typeof file.id !== "string" || !LABEL_RE.test(file.id)) return bad("id is invalid");
  if (typeof file.waVersion !== "string" || !LABEL_RE.test(file.waVersion)) return bad("waVersion is invalid");
  if (typeof file.apiVersionHash !== "string" || !HASH_RE.test(file.apiVersionHash)) {
    return bad("apiVersionHash must be 8 lowercase hex characters");
  }
  if (!SERVERS.includes(file.server)) return bad(`server must be one of ${SERVERS.join(", ")}`);
  if (typeof file.protoFamily !== "string" || !Object.hasOwn(builtins, file.protoFamily)) {
    return bad(`protoFamily "${file.protoFamily}" is not a known adapter`);
  }
  const out = {
    schema: 1,
    id: file.id,
    waVersion: file.waVersion,
    apiVersionHash: file.apiVersionHash,
    server: file.server,
    protoFamily: file.protoFamily,
  };

  if (file.meeting !== undefined) {
    if (!isObj(file.meeting)) return bad("meeting must be an object");
    const m = {};
    const { areaDwellMs, areaLingerMs } = file.meeting;
    if (areaDwellMs !== undefined) {
      if (!Number.isInteger(areaDwellMs) || !inRange(areaDwellMs, BOUNDS.dwellMs)) {
        return bad(`meeting.areaDwellMs must be an integer ${BOUNDS.dwellMs.join(" to ")}`);
      }
      m.areaDwellMs = areaDwellMs;
    }
    if (areaLingerMs !== undefined) {
      if (!Number.isInteger(areaLingerMs) || !inRange(areaLingerMs, BOUNDS.lingerMs)) {
        return bad(`meeting.areaLingerMs must be an integer ${BOUNDS.lingerMs.join(" to ")}`);
      }
      m.areaLingerMs = areaLingerMs;
    }
    out.meeting = m;
  }

  if (file.movement !== undefined) {
    if (!isObj(file.movement)) return bad("movement must be an object");
    const mv = {};
    for (const k of ["walkPxPerS", "runPxPerS"]) {
      const v = file.movement[k];
      if (v === undefined) continue;
      if (!inRange(v, BOUNDS.speed)) return bad(`movement.${k} must be a number ${BOUNDS.speed.join(" to ")}`);
      mv[k] = v;
    }
    out.movement = mv;
  }

  if (file.handshake !== undefined) {
    const r = checkHandshake(file.handshake);
    if (r.reason) return bad(r.reason);
    out.handshake = { query: r.query };
  }
  return { ok: true, file: out };
}

/** Lay a validated file over its built-in protoFamily adapter; the built-in is not mutated. */
export function buildAdapter(file, builtins) {
  const base = builtins[file.protoFamily];
  const adapter = {
    ...base,
    id: file.id,
    waVersion: file.waVersion,
    stability: "catalog",
    apiVersionHashes: [file.apiVersionHash, ...(base.apiVersionHashes ?? []).filter((h) => h !== file.apiVersionHash)],
    meeting: { ...base.meeting, ...file.meeting },
    movement: { ...base.movement, ...file.movement },
  };
  if (file.handshake) adapter.handshake = { query: { ...file.handshake.query } };
  return adapter;
}
