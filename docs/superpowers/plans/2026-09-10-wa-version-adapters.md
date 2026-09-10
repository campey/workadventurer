# WorkAdventure Version Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the headless client a version-target seam — one adapter per WorkAdventure `major.minor` holding every build-specific constant and behaviour — auto-detected from the server, with the prod (`wa-1.33`) adapter frozen so staging/`master` work can't regress it.

**Architecture:** A new `src/adapters/` module. Each adapter is a plain object; `wa-1.33.mjs` is the baseline (today's inlined constants, verbatim), `wa-master.mjs` spreads it and overrides only what differs. `src/adapters/index.mjs` resolves an adapter from an explicit override, else an HTTP probe of the server's landing page, else a host allowlist, else a warned default. `wa-client.mjs` / `wa-audio.mjs` / `wa-daemon.mjs` / `config.mjs` / `bin/wa.mjs` read every pinned value from the resolved adapter instead of hardcoding it. A `wa selfcheck` smoke test guards the prod path.

**Tech Stack:** Node ≥18 (ESM `.mjs`, `node:test`, `fetch` + `AbortSignal.timeout`), `protobufjs`, `werift`, `ws`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-wa-version-adapters-design.md`

## Global Constraints

- **No new npm dependencies.** `node:test` (built in) is the only new tool.
- **`wa-1.33` is frozen after Task 3.** Later tasks never edit `src/adapters/wa-1.33.mjs`, shared code in `wa-client.mjs`/`wa-audio.mjs`, or `proto/wa-1.33/`. `master` work lives only in `wa-master.mjs` and `proto/wa-master/`.
- **Adapter key is `wa-<major>.<minor>`.** A patch release that shifts the `apiVersionHash` appends to that adapter's `apiVersionHashes` array — it never forks a new adapter file.
- **Every value moved into an adapter must be byte-identical to what the code uses today.** Task 3 is a pure no-op refactor; behaviour against afrolabs must be unchanged.
- **ESM only**, `import`/`export`, `.mjs` extensions, 2-space indent, match the terse comment style of the existing `src/` files.
- Files stay small and single-purpose (`src/` files are 80–840 lines today; keep new files well under that).
- Prod verification command, unchanged across the whole plan:
  `node scripts/selfcheck.mjs` (defaults to afrolabs) must print all `PASS`/`SKIP`, no `FAIL`.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `src/adapters/wa-helpers.mjs` | `shortHash`, `slugify` — ports of WA `libs/shared-utils`, moved out of `wa-client.mjs` so adapters can call them |
| `src/adapters/wa-1.33.mjs` | Baseline adapter object: prod `v1.33.5` constants + behaviours, verbatim from today's code |
| `src/adapters/wa-master.mjs` | `{ ...wa133, <overrides> }` — rolling `master`; initially only proto path + hash + a `verified` record |
| `src/adapters/index.mjs` | `ADAPTERS` registry, `matchVersion(html)`, `probeVersion(roomUrl)`, `resolveAdapter({roomUrl, override, probeFn})` |
| `test/adapters.test.mjs` | `node:test` unit tests for `matchVersion` + `resolveAdapter` (pure; probe injected) |
| `scripts/selfcheck.mjs` | Ephemeral-client smoke test, `--target` / `--room` aware; prints `PASS`/`FAIL`/`SKIP` per step, non-zero exit on any `FAIL` |
| `scripts/vendor-proto.mjs` | Fetch `messages.proto` + `JsonMessages/*` from `workadventure` at a git ref into `proto/<name>/`, compute + print the `apiVersionHash` |

**Moved:**

- `proto/messages.proto` → `proto/wa-1.33/messages.proto`

**Modified:**

| File | Change |
|---|---|
| `src/wa-client.mjs` | Accept `opts.adapter` / `opts.target`; resolve in `connect()`; read proto path, api-hash, endpoints, space-join knobs, area-space-name, mic-state mask from `this.adapter`; drop the module-level `shortHash`/`slugify` |
| `src/wa-audio.mjs` | Read mic-state mask + WEBRTC strategy name from `this.client.adapter` |
| `src/config.mjs` | `WA_TARGET → target` (default `"auto"`); `version` default becomes `null`; `configToEnv` mirrors `WA_TARGET` and only emits `WA_VERSION` when set |
| `src/wa-daemon.mjs` | Pass `target: cfg.target` to both client constructions; `state()` gains a `target` block; USAGE comment |
| `bin/wa.mjs` | `--target` option; `wa selfcheck` subcommand; `prettyStatus` shows the target line; USAGE |
| `README.md` | New `## Version targets` section; update `proto/` path references |
| `CHANGELOG.md` | `Unreleased` entry |

---

## Task 1: Adapter helpers + `wa-1.33` baseline object

**Files:**
- Create: `src/adapters/wa-helpers.mjs`
- Create: `src/adapters/wa-1.33.mjs`
- Reference (do not edit yet): `src/wa-client.mjs:21-54` (source of the verbatim values)

**Interfaces:**
- Produces:
  - `wa-helpers.mjs`: `export function shortHash(s: string): string`, `export function slugify(...args: string[]): string`
  - `wa-1.33.mjs`: `export default` an object with exactly these keys:
    ```
    id: "wa-1.33"
    waVersion: "1.33"
    stability: "frozen"
    apiVersionHashes: string[]                      // ["bfd20fc4"]
    protoPath: string                               // "proto/wa-1.33/messages.proto"
    defaultWokaId: string
    endpoints: { anonymLogin: string, map: string, wokaList: string }
    wokaListAuthHeader: (token: string) => Record<string,string>
    envelope: "seq-len-v1"
    spaceJoin: { filterType: number, defaultPropsToSync: string[],
                 watchViaAddSpaceFilter: boolean, micReannounceMs: number[] }
    areaMeetingSpaceName: (roomUrl: string, prop: {roomName?: string, id: string}) => string
    emote: { wireFormat: "emoji-string", channel: "sub.emoteEventMessage" }
    micState: { updateMaskPaths: string[], speakingMaskPaths: string[] }
    meeting: { webrtcStrategyName: "WEBRTC" }
    ```

- [ ] **Step 1: Create `src/adapters/wa-helpers.mjs`** — move the two helpers out of `wa-client.mjs` verbatim (currently lines 23–40):

```js
// Ports of WorkAdventure's libs/shared-utils helpers. Used to derive the space
// name of a map-area meeting the same way the front-end does, and kept here so
// per-version adapters can call them.

export function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

export function slugify(...args) {
  return args
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-");
}
```

Note: the original used a literal combining-marks character class (`/[̀-ͯ]/g`). `̀-ͯ` is the same range written portably — verify equivalence in Step 3.

- [ ] **Step 2: Create `src/adapters/wa-1.33.mjs`**:

```js
// Baseline adapter: WorkAdventure prod (play.workadventu.re, build v1.33.5).
// Every value here is what src/wa-client.mjs / src/wa-audio.mjs used inline
// before the version-adapter seam. FROZEN — do not change for staging/master
// work; see docs/superpowers/specs/2026-09-10-wa-version-adapters-design.md.

import { shortHash, slugify } from "./wa-helpers.mjs";

export default {
  id: "wa-1.33",
  waVersion: "1.33",
  stability: "frozen",

  // --- mechanical ---
  // A SET of accepted apiVersionHash values: a patch release can shift the hash
  // with no behaviour change — append here, never fork a new adapter file.
  apiVersionHashes: ["bfd20fc4"],
  protoPath: "proto/wa-1.33/messages.proto",
  defaultWokaId: "506a3a64-47a9-4587-b19b-2d1eb13f9790",
  endpoints: { anonymLogin: "/anonymLogin", map: "/map", wokaList: "/woka/list" },
  wokaListAuthHeader: (token) => ({ Authorization: token }), // bare token, no "Bearer"
  envelope: "seq-len-v1",

  // --- behaviours ---
  spaceJoin: {
    filterType: 0, // ALL_USERS
    defaultPropsToSync: ["cameraState", "microphoneState", "screenSharingState"],
    watchViaAddSpaceFilter: true,
    micReannounceMs: [0, 1000, 3000], // #10 mitigation: re-announce mic-on
  },
  areaMeetingSpaceName: (roomUrl, prop) =>
    slugify(
      shortHash(roomUrl) + "-" + (prop.roomName?.trim() ? prop.roomName : prop.id)
    ),
  emote: { wireFormat: "emoji-string", channel: "sub.emoteEventMessage" },
  micState: {
    updateMaskPaths: ["microphoneState"],
    speakingMaskPaths: ["showVoiceIndicator", "microphoneState"],
  },
  meeting: { webrtcStrategyName: "WEBRTC" },
};
```

- [ ] **Step 3: Sanity-check the helper port**

Run:
```bash
node -e '
import("./src/adapters/wa-helpers.mjs").then(({shortHash, slugify}) => {
  const room = "https://play.workadventu.re/@/afrolabs/afrolabs/open-space";
  console.log(shortHash(room), slugify(shortHash(room) + "-Lean Coffee Table 1"));
  // combining-marks equivalence:
  console.log(slugify("Café Meeting"));  // expect "cafe-meeting"
});
'
```
Expected: a base-36 hash, a lowercase-dashed slug, and `cafe-meeting` (accent stripped).

- [ ] **Step 4: Commit**

```bash
git add src/adapters/wa-helpers.mjs src/adapters/wa-1.33.mjs
git commit -m "adapters: wa-helpers + wa-1.33 baseline object"
```

---

## Task 2: `wa-master` adapter + `matchVersion` / `probeVersion` / `resolveAdapter`

**Files:**
- Create: `src/adapters/wa-master.mjs`
- Create: `src/adapters/index.mjs`
- Test: `test/adapters.test.mjs`
- Modify: `package.json` (add `"test": "node --test"` to `scripts`)

**Interfaces:**
- Consumes: `wa-1.33.mjs` default export (Task 1)
- Produces:
  - `wa-master.mjs`: `export default` — `{ ...wa133 }` with `id:"wa-master"`, `waVersion:"master"`, `stability:"tracking"`, `trackedSha:string`, `verifiedDate:string`, `verified:{ok:string[],broken:string[]}`, `apiVersionHashes:string[]`, `protoPath:"proto/wa-master/messages.proto"`
  - `index.mjs`:
    - `export const ADAPTERS: Record<string, Adapter>` — keys `"wa-1.33"`, `"wa-master"`
    - `export function matchVersion(html: string): {kind:"release", minor:string, raw:string} | {kind:"master", sha:string, raw:string} | null`
    - `export async function probeVersion(roomUrl: string): Promise<ReturnType<matchVersion>>` — GETs `<origin>/`, returns `matchVersion(body)` or `null` on any failure
    - `export async function resolveAdapter(opts: {roomUrl?: string, override?: string, probeFn?: (roomUrl)=>Promise<...>}): Promise<{adapter: Adapter, why: string, warn?: boolean}>`

- [ ] **Step 1: Create `src/adapters/wa-master.mjs`**

```js
// Rolling-master adapter for play.staging.workadventu.re. Spreads the frozen
// wa-1.33 baseline and overrides only what has drifted. Stability "tracking":
// a failing `selfcheck --target wa-master` is a known-issues note, not a merge
// blocker. Refresh trackedSha / apiVersionHashes / proto via scripts/vendor-proto.mjs.

import wa133 from "./wa-1.33.mjs";

export default {
  ...wa133,
  id: "wa-master",
  waVersion: "master",
  stability: "tracking",
  trackedSha: "7d628838",
  verifiedDate: "2026-09-10",
  verified: {
    ok: ["join", "move", "bubble", "emote"],
    broken: ["proximity audio — red mic / #10 mic-state race"],
  },
  // Recomputed at trackedSha (see README § apiVersionHash). Stale once the
  // staging sha moves — resolveAdapter warns when it detects drift.
  apiVersionHashes: ["907396a8"],
  protoPath: "proto/wa-master/messages.proto",
  // Behavioural overrides go here as they are discovered — none needed yet.
};
```

- [ ] **Step 2: Write the failing tests — `test/adapters.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTERS,
  matchVersion,
  resolveAdapter,
} from "../src/adapters/index.mjs";

test("matchVersion picks a release minor from landing-page HTML", () => {
  assert.deepEqual(matchVersion('<meta>build v1.33.5</meta>'), {
    kind: "release",
    minor: "1.33",
    raw: "v1.33.5",
  });
});

test("matchVersion picks a master sha", () => {
  const m = matchVersion("<span>master@7d628838d9449e41684dda32</span>");
  assert.equal(m.kind, "master");
  assert.equal(m.sha, "7d628838d9449e41684dda32");
});

test("matchVersion returns null when nothing matches", () => {
  assert.equal(matchVersion("<html>nothing here</html>"), null);
});

test("resolveAdapter: explicit override wins and skips the probe", async () => {
  let probed = false;
  const r = await resolveAdapter({
    roomUrl: "https://example.com/@/x/y/z",
    override: "wa-master",
    probeFn: async () => ((probed = true), null),
  });
  assert.equal(r.adapter.id, "wa-master");
  assert.equal(probed, false);
  assert.match(r.why, /explicit/);
});

test("resolveAdapter: unknown override throws with the known list", async () => {
  await assert.rejects(
    () => resolveAdapter({ override: "wa-9.9" }),
    /unknown .*wa-9\.9.*wa-1\.33/s
  );
});

test("resolveAdapter: probed v1.33.x -> wa-1.33", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    probeFn: async () => ({ kind: "release", minor: "1.33", raw: "v1.33.5" }),
  });
  assert.equal(r.adapter.id, "wa-1.33");
  assert.ok(!r.warn);
});

test("resolveAdapter: probed unknown minor -> newest released + warn", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    probeFn: async () => ({ kind: "release", minor: "1.34", raw: "v1.34.0" }),
  });
  assert.equal(r.adapter.id, "wa-1.33");
  assert.equal(r.warn, true);
  assert.match(r.why, /no wa-1\.34/);
});

test("resolveAdapter: probed master, sha matches tracked -> no warn", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.staging.workadventu.re/@/a/b/c",
    probeFn: async () => ({ kind: "master", sha: "7d628838", raw: "master@7d628838" }),
  });
  assert.equal(r.adapter.id, "wa-master");
  assert.ok(!r.warn);
});

test("resolveAdapter: probed master, sha drifted -> warn names both shas", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.staging.workadventu.re/@/a/b/c",
    probeFn: async () => ({ kind: "master", sha: "abc1234", raw: "master@abc1234" }),
  });
  assert.equal(r.adapter.id, "wa-master");
  assert.equal(r.warn, true);
  assert.match(r.why, /abc1234/);
  assert.match(r.why, /7d628838/);
});

test("resolveAdapter: probe fails, known host -> allowlist", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.workadventu.re/@/a/b/c",
    probeFn: async () => null,
  });
  assert.equal(r.adapter.id, "wa-1.33");
  assert.match(r.why, /allowlist/);
});

test("resolveAdapter: probe fails, unknown host -> warned default", async () => {
  const r = await resolveAdapter({
    roomUrl: "https://play.example.org/@/a/b/c",
    probeFn: async () => null,
  });
  assert.equal(r.adapter.id, "wa-1.33");
  assert.equal(r.warn, true);
  assert.match(r.why, /default/);
});
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `node --test test/adapters.test.mjs`
Expected: FAIL — `Cannot find module '../src/adapters/index.mjs'`.

- [ ] **Step 4: Create `src/adapters/index.mjs`**

```js
// Version-target registry + resolver. Given a room URL, decide which adapter
// (proto + apiVersionHash + behaviours) to talk to the server with. See
// docs/superpowers/specs/2026-09-10-wa-version-adapters-design.md.

import wa133 from "./wa-1.33.mjs";
import waMaster from "./wa-master.mjs";

export const ADAPTERS = {
  "wa-1.33": wa133,
  "wa-master": waMaster,
};

// Released adapters, oldest first; last is "newest released".
const RELEASED = [wa133];

// Fallback when the probe can't reach or parse the server.
const HOST_ALLOWLIST = {
  "play.workadventu.re": "wa-1.33",
};

/** Pull a version marker out of a WorkAdventure landing page. */
export function matchVersion(html) {
  const rel = html.match(/v(\d+)\.(\d+)\.\d+/);
  if (rel) return { kind: "release", minor: `${rel[1]}.${rel[2]}`, raw: rel[0] };
  const m = html.match(/master@([0-9a-f]{7,40})/);
  if (m) return { kind: "master", sha: m[1], raw: m[0] };
  return null;
}

/** GET the server's landing page and read its version marker; null on any failure. */
export async function probeVersion(roomUrl) {
  let origin;
  try {
    origin = new URL(roomUrl).origin;
  } catch {
    return null;
  }
  try {
    const res = await fetch(origin + "/", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return matchVersion(await res.text());
  } catch {
    return null;
  }
}

const shaDrift = (a, b) => !(a.startsWith(b) || b.startsWith(a));

/**
 * Resolve a target adapter. Precedence: explicit override > server probe >
 * host allowlist > warned default (wa-1.33).
 * @param {{roomUrl?:string, override?:string, probeFn?:(url:string)=>Promise<any>}} opts
 */
export async function resolveAdapter({ roomUrl, override, probeFn = probeVersion } = {}) {
  if (override && override !== "auto") {
    const a = ADAPTERS[override];
    if (!a) {
      throw new Error(
        `unknown target "${override}" (known: ${Object.keys(ADAPTERS).join(", ")})`
      );
    }
    return { adapter: a, why: `explicit target ${override}` };
  }

  const probe = roomUrl ? await probeFn(roomUrl) : null;

  if (probe?.kind === "release") {
    const key = `wa-${probe.minor}`;
    if (ADAPTERS[key]) return { adapter: ADAPTERS[key], why: `probed ${probe.raw}` };
    const newest = RELEASED[RELEASED.length - 1];
    return {
      adapter: newest,
      why: `probed ${probe.raw} — no ${key} adapter, using ${newest.id} behaviours`,
      warn: true,
    };
  }

  if (probe?.kind === "master") {
    const a = ADAPTERS["wa-master"];
    const drift = a.trackedSha && shaDrift(probe.sha, a.trackedSha);
    return {
      adapter: a,
      why: drift
        ? `probed master@${probe.sha} — adapter tracks master@${a.trackedSha} (${a.verifiedDate}), behaviours may have drifted`
        : `probed master@${probe.sha}`,
      ...(drift ? { warn: true } : {}),
    };
  }

  try {
    const host = new URL(roomUrl).host;
    if (HOST_ALLOWLIST[host]) {
      return { adapter: ADAPTERS[HOST_ALLOWLIST[host]], why: `host allowlist (${host})` };
    }
  } catch {
    /* fall through */
  }

  return { adapter: wa133, why: "default (probe failed, host not in allowlist)", warn: true };
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `node --test test/adapters.test.mjs`
Expected: PASS — 11/11.

- [ ] **Step 6: Add the `test` script to `package.json`**

In `"scripts"`, add: `"test": "node --test"`

- [ ] **Step 7: Run `npm test`**

Run: `npm test`
Expected: PASS — discovers `test/adapters.test.mjs`, 11/11.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/wa-master.mjs src/adapters/index.mjs test/adapters.test.mjs package.json
git commit -m "adapters: wa-master + resolveAdapter (probe / allowlist / default)"
```

---

## Task 3: Wire the client, audio, config and daemon to the adapter (no-op refactor)

This is the risky task: it must not change behaviour against prod. Do it in one commit so a reviewer sees the whole substitution, and verify with `selfcheck` (Task 4 builds the real one; use the manual checks below until then).

**Files:**
- Modify: `src/wa-client.mjs`
- Modify: `src/wa-audio.mjs`
- Modify: `src/config.mjs`
- Modify: `src/wa-daemon.mjs`
- Move: `proto/messages.proto` → `proto/wa-1.33/messages.proto`

**Interfaces:**
- Consumes: `resolveAdapter` (Task 2), `ADAPTERS` (Task 2)
- Produces:
  - `WorkAdventureClient` constructor accepts `opts.adapter?: Adapter` and `opts.target?: string` (default `"auto"`); after `connect()` resolves, `client.adapter` is always set
  - `resolveConfig()` return object gains `target: string` (default `"auto"`); its `version` is now `string | null`
  - `configToEnv(cfg)` emits `WA_TARGET` always, `WA_VERSION` only when `cfg.version` is set

- [ ] **Step 1: Move the proto file**

```bash
mkdir -p proto/wa-1.33
git mv proto/messages.proto proto/wa-1.33/messages.proto
```

- [ ] **Step 2: `src/wa-client.mjs` — imports and constructor**

Replace the module-level `shortHash`/`slugify` block (lines ~21–40) with:

```js
import { resolveAdapter } from "./adapters/index.mjs";
```

(add near the other imports; delete the two helper functions entirely — they now live in `wa-helpers.mjs`, reachable via the adapter).

In `DEFAULTS`, change:

```js
  // apiVersionHash override. Normally null — the resolved adapter supplies it.
  // Set (via WA_VERSION) only to probe a build that has no adapter yet.
  version: null,
  // Version target: "auto" (probe the server) or an adapter id ("wa-1.33").
  target: "auto",
```

(remove the old `version: "bfd20fc4"` line and its comment; `wokaId` default stays as-is for now — the adapter's `defaultWokaId` is wired in a later stage, keep this task minimal).

In the constructor, after `this.cfg = { ...DEFAULTS, ...opts };`:

```js
    this.adapter = opts.adapter ?? null;
    this._target = this.cfg.target ?? "auto";
```

- [ ] **Step 3: `src/wa-client.mjs` — resolve in `connect()`**

At the very top of `connect()`, before `await this._loadProto();`:

```js
    if (!this.adapter) {
      const { adapter, why, warn } = await resolveAdapter({
        roomUrl: this.cfg.roomUrl,
        override: this._target,
      });
      this.adapter = adapter;
      this.emit("log", `${warn ? "⚠ " : ""}adapter ${adapter.id} (${why})`);
    }
    if (this.adapter.envelope !== "seq-len-v1") {
      throw new Error(`adapter ${this.adapter.id} needs envelope ${this.adapter.envelope}; client only implements seq-len-v1`);
    }
```

- [ ] **Step 4: `src/wa-client.mjs` — use adapter values at each call site**

`_loadProto()`:
```js
    this._root = await protobuf.load(path.join(__dirname, "..", this.adapter.protoPath));
```

`_wsUrl()` — the `version` param:
```js
    u.searchParams.set("version", this.cfg.version || this.adapter.apiVersionHashes[0]);
```

`_anonymLogin()`:
```js
    const res = await fetch(`${this.cfg.pusherUrl}${this.adapter.endpoints.anonymLogin}`, {
```

`_loadAreas()` — the map fetch:
```js
      const mapInfo = await get(
        `${this.cfg.pusherUrl}${this.adapter.endpoints.map}?playUri=${encodeURIComponent(this.cfg.roomUrl)}`
      );
```

`_joinSpace(spaceName, propertiesToSync)` — replace the hardcoded bits:
```js
  async _joinSpace(spaceName, propertiesToSync) {
    const sj = this.adapter.spaceJoin;
    const props = propertiesToSync?.length ? propertiesToSync : sj.defaultPropsToSync;
    const answer = await this.query("joinSpaceQuery", {
      spaceName,
      filterType: sj.filterType,
      propertiesToSync: props,
    });
    const spaceUserId = answer.joinSpaceAnswer?.spaceUserId ?? "";
    this.spaces.set(spaceName, { spaceUserId, propertiesToSync: props });
    this.emit("log", `joined space ${spaceName} as ${spaceUserId}`);
    if (sj.watchViaAddSpaceFilter) {
      this._send({ addSpaceFilterMessage: { spaceFilterMessage: { spaceName } } });
    }
    this.emit("spaceJoined", { spaceName, spaceUserId });
    if (this.micOn) {
      for (const ms of sj.micReannounceMs) {
        if (ms === 0) this.setSpaceMicState(spaceName, true);
        else setTimeout(() => this.setSpaceMicState(spaceName, true), ms);
      }
    }
    return spaceUserId;
  }
```
(keep the existing explanatory comments about *why* watch/re-announce are needed.)

`_areaSpaceName(prop)`:
```js
  _areaSpaceName(prop) {
    return this.adapter.areaMeetingSpaceName(this.cfg.roomUrl, prop);
  }
```

`setSpaceMicState(spaceName, on)` — the mask:
```js
        updateMask: { paths: this.adapter.micState.updateMaskPaths },
```

- [ ] **Step 5: `src/wa-audio.mjs` — adapter values**

`_setSpeaking(on)` — the mask:
```js
            updateMask: { paths: this.client.adapter.micState.speakingMaskPaths },
```

`_onSpaceEvent`, the `switchMessage`/`finalizeSwitchMessage` case:
```js
        if (payload.strategy && payload.strategy.toUpperCase() !== this.client.adapter.meeting.webrtcStrategyName) {
```

- [ ] **Step 6: `src/config.mjs`**

`ENV_MAP` — add:
```js
  WA_TARGET: "target",
```

`BASE` — `version` now inherits `null` from `CLIENT_DEFAULTS`; add `target`:
```js
  version: CLIENT_DEFAULTS.version,   // null unless WA_VERSION / flag set
  target: CLIENT_DEFAULTS.target,     // "auto"
```

`configToEnv(cfg)`:
```js
export function configToEnv(cfg) {
  return {
    WA_ROOM: cfg.roomUrl,
    WA_NAME: cfg.name,
    WA_PUSHER_URL: cfg.pusherUrl,
    WA_TARGET: cfg.target,
    WA_WOKA_ID: cfg.wokaId,
    WA_DAEMON_PORT: String(cfg.port),
    ...(cfg.version ? { WA_VERSION: cfg.version } : {}),
  };
}
```

- [ ] **Step 7: `src/wa-daemon.mjs`**

Both `new WorkAdventureClient({ ... })` blocks (in `attemptReconnect` ~line 283 and at startup ~line 449): add `target: cfg.target,` and change `version: cfg.version` to keep passing it (null is fine — the client falls back to the adapter). Result:
```js
  const client = new WorkAdventureClient({
    name: cfg.name,
    roomUrl: cfg.roomUrl,
    pusherUrl: cfg.pusherUrl,
    target: cfg.target,
    version: cfg.version,
    wokaId: cfg.wokaId,
    micOn: true,
  });
```

In `state()`, add after the `room:` line:
```js
    target: wa.adapter
      ? {
          id: wa.adapter.id,
          waVersion: wa.adapter.waVersion,
          stability: wa.adapter.stability,
          verified: wa.adapter.verified ?? null,
        }
      : null,
```

- [ ] **Step 8: Run the unit tests**

Run: `npm test`
Expected: PASS — 11/11 (unchanged; this task doesn't touch the resolver).

- [ ] **Step 9: Manual prod verification (no `selfcheck` yet)**

Start a daemon against the default room and exercise the paths that use adapter values:

```bash
node src/wa-daemon.mjs &
sleep 8
curl -s localhost:8787/state | node -e 'const s=JSON.parse(require("fs").readFileSync(0));console.log("adapter:",s.target);console.log("connected:",s.connected)'
curl -s -XPOST localhost:8787/goto -d "{\"x\":1600,\"y\":1520}" ; echo
curl -s -XPOST localhost:8787/speech-bubble -d "{\"text\":\"adapter refactor check\"}" ; echo
sleep 3
curl -s -XPOST localhost:8787/clear-bubble ; echo
curl -s -XPOST localhost:8787/leave ; echo
```

Expected:
- `/state` → `adapter: { id: "wa-1.33", waVersion: "1.33", stability: "frozen", verified: null }`, `connected: true`
- daemon log shows `adapter wa-1.33 (probed v1.33.5)` (or `(host allowlist ...)` if the probe is slow)
- goto / speech-bubble / clear-bubble all return `ok`
- no `errorScreen` / `NEW_VERSION` in the log

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "adapters: wire client/audio/config/daemon to the resolved adapter

No-op refactor — every value now read from the adapter is byte-identical to
what was inlined. proto/messages.proto -> proto/wa-1.33/messages.proto."
```

---

## Task 4: `wa selfcheck` smoke test

**Files:**
- Create: `scripts/selfcheck.mjs`
- Modify: `bin/wa.mjs` (add the `selfcheck` case + `--target` option + USAGE)

**Interfaces:**
- Consumes: `WorkAdventureClient` (with `opts.target`), `resolveConfig`
- Produces: `node scripts/selfcheck.mjs [--target <id>] [--room <url>]` — prints one `PASS`/`FAIL`/`SKIP` line per step; exit `0` if no `FAIL`, `1` otherwise. `wa selfcheck` forwards to it.

- [ ] **Step 1: Create `scripts/selfcheck.mjs`**

```js
// Smoke test for a version target: connect an ephemeral client (not the daemon),
// exercise the paths that depend on adapter values, print PASS/FAIL/SKIP per
// step. `wa selfcheck --target production` must stay green across any change.
//
//   node scripts/selfcheck.mjs [--target <id>] [--room <url>]

import { WorkAdventureClient } from "../src/wa-client.mjs";
import { resolveConfig } from "../src/config.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// "production" is a friendly alias for the auto-detected prod adapter.
const rawTarget = opt("target") ?? "auto";
const target = rawTarget === "production" ? "auto" : rawTarget;
const cfg = resolveConfig({ target, roomUrl: opt("room") });

let failed = false;
const line = (status, step, detail = "") => {
  if (status === "FAIL") failed = true;
  console.log(`${status.padEnd(4)}  ${step}${detail ? "  — " + detail : ""}`);
};

const client = new WorkAdventureClient({
  name: "selfcheck",
  roomUrl: cfg.roomUrl,
  pusherUrl: cfg.pusherUrl,
  target: cfg.target,
  version: cfg.version,
  wokaId: cfg.wokaId,
});

const errors = [];
client.on("error", (e) => errors.push(e.message));

try {
  // --- connect ---
  await Promise.race([
    client.connect(),
    new Promise((_, r) => setTimeout(() => r(new Error("15s timeout")), 15000)),
  ]);
  line("PASS", "connect + join", `userId ${client.myUserId}`);
  line("PASS", "adapter resolved", `${client.adapter.id} (${client.adapter.waVersion})`);

  // --- adapter match: a NEW_VERSION errorScreen would have landed in `errors` ---
  if (errors.some((m) => /version/i.test(m))) {
    line("FAIL", "apiVersionHash accepted", errors.find((m) => /version/i.test(m)));
  } else {
    line("PASS", "apiVersionHash accepted");
  }

  // --- move ---
  const before = { ...client.pos };
  await client.walkTo(before.x + 64, before.y, { timeoutMs: 8000 });
  const moved = Math.hypot(client.pos.x - before.x, client.pos.y - before.y);
  line(moved > 32 ? "PASS" : "FAIL", "move", `moved ${moved.toFixed(0)}px`);

  // --- bubble ---
  try {
    client.speechBubble("selfcheck");
    client.clearBubble();
    line("PASS", "speech bubble set + clear");
  } catch (e) {
    line("FAIL", "speech bubble set + clear", e.message);
  }

  // --- area meeting (best-effort) ---
  const meetingArea = (client.areas ?? []).find((a) =>
    (a.rawProps ?? []).some((p) => p.type === "livekitRoomProperty")
  );
  if (!meetingArea) {
    line("SKIP", "area meeting join", "no livekitRoomProperty area on this map");
  } else {
    const joined = new Promise((res) => client.once("spaceJoined", res));
    await client.walkTo(meetingArea.x + meetingArea.w / 2, meetingArea.y + meetingArea.h / 2, { timeoutMs: 15000 });
    const ok = await Promise.race([joined.then(() => true), new Promise((r) => setTimeout(() => r(false), 8000))]);
    line(ok ? "PASS" : "FAIL", "area meeting join", `"${meetingArea.name}"`);
  }

  // --- audio (best-effort; needs a live peer) ---
  line("SKIP", "audio into meeting", "no second participant in an automated run");
} catch (e) {
  line("FAIL", "connect + join", e.message);
} finally {
  client.close();
  console.log(failed ? "\nFAIL" : "\nOK");
  process.exit(failed ? 1 : 0);
}
```

- [ ] **Step 2: Add `--target` + `selfcheck` to `bin/wa.mjs`**

In the `parseArgs` options object, add:
```js
    target: { type: "string" },
```

In the command `switch`, add a case (near `status`):
```js
    case "selfcheck": {
      const { spawnSync } = await import("node:child_process");
      const scArgs = [];
      if (flags.target) scArgs.push("--target", flags.target);
      if (flags.room) scArgs.push("--room", flags.room);
      const r = spawnSync(
        process.execPath,
        [new URL("../scripts/selfcheck.mjs", import.meta.url).pathname, ...scArgs],
        { stdio: "inherit" }
      );
      process.exit(r.status ?? 1);
    }
```
(If `bin/wa.mjs` has no `flags.room` option today, add `room: { type: "string" }` alongside `target`.)

In the `USAGE` string, add under the command list:
```
  selfcheck [--target <id>] [--room <url>]   smoke-test a version target
```

- [ ] **Step 3: Run `selfcheck` against prod**

Run: `node scripts/selfcheck.mjs`
Expected: `PASS` for connect/adapter/apiVersionHash/move/bubble; `PASS` or `SKIP` for area meeting (afrolabs `open-space` has no livekit area → `SKIP`); `SKIP` for audio; final line `OK`; exit 0.

- [ ] **Step 4: Run it via the CLI**

Run: `node bin/wa.mjs selfcheck --target wa-1.33`
Expected: same output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/selfcheck.mjs bin/wa.mjs
git commit -m "wa selfcheck: smoke-test a version target"
```

---

## Task 5: Surface the target in `wa status`, doc it, changelog

**Files:**
- Modify: `bin/wa.mjs` (`prettyStatus`)
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `state().target` (Task 3)

- [ ] **Step 1: `prettyStatus` in `bin/wa.mjs` — show the target**

Find where `prettyStatus` prints `room` / `facing` and add a line:
```js
  if (s.target) {
    out.push(`  target   ${s.target.id} (WA ${s.target.waVersion}, ${s.target.stability})`);
  }
```
(match the surrounding formatting — align with the existing `prettyStatus` field style, whatever it is.)

- [ ] **Step 2: Verify against a running daemon**

```bash
node src/wa-daemon.mjs &
sleep 8
node bin/wa.mjs status
curl -s -XPOST localhost:8787/leave
```
Expected: `status` output includes `target   wa-1.33 (WA 1.33, frozen)`.

- [ ] **Step 3: `README.md` — new `## Version targets` section**

Insert after the `## The protocol` section's intro (before `### 1. Endpoints`), a new top-level section:

```markdown
## Version targets

WorkAdventure's wire protocol is reverse-engineered and version-specific. Each
supported build has an **adapter** under `src/adapters/` carrying its
`apiVersionHash` set, proto path, endpoint paths and behavioural quirks
(space-join handshake, area-meeting space-name derivation, mic-state mask, …).

| adapter | server | stability |
|---|---|---|
| `wa-1.33` | `play.workadventu.re` (build `v1.33.5`) | frozen — the verified prod baseline |
| `wa-master` | `play.staging.workadventu.re` (rolling `master`) | tracking — best-effort, may lag |

**Selection** (`resolveAdapter`): explicit `--target` / `WA_TARGET` wins;
otherwise the client GETs the server's landing page, reads `v1.33.5` or
`master@<sha>`, and maps it to `wa-<major>.<minor>` / `wa-master`; otherwise a
host allowlist; otherwise a warned default of `wa-1.33`. The chosen adapter and
the reason are logged on connect and shown in `wa status`.

A patch release that shifts the `apiVersionHash` **appends** to that adapter's
`apiVersionHashes` — it does not fork a new adapter. Refresh `wa-master` with
`node scripts/vendor-proto.mjs <ref>` (prints the recomputed hash).

**Before any change touching `src/`:** `node scripts/selfcheck.mjs` (prod) must
stay green. `--target wa-master` is advisory.
```

Also update the two `proto/messages.proto` path references (Project layout table ~line 156, and the apiVersionHash recipe ~line 234) to `proto/wa-1.33/messages.proto`.

- [ ] **Step 4: `CHANGELOG.md` — `Unreleased` entry**

Under `## [Unreleased]` → `### Added`:
```markdown
- **Version-target adapters.** `src/adapters/` — one adapter per WorkAdventure
  `major.minor` (`wa-1.33` for prod, `wa-master` for staging) carrying its
  `apiVersionHash` set, proto path, endpoints and behavioural quirks. The client
  auto-detects the target from the server's landing page (override with
  `--target` / `WA_TARGET`), falling back to a host allowlist then a warned
  default. `wa status` and `GET /state` report the resolved target.
  `wa selfcheck [--target <id>]` smoke-tests a target; the prod run is the merge
  gate. `proto/messages.proto` moved to `proto/wa-1.33/messages.proto`.
```

- [ ] **Step 5: Run the full test suite + prod selfcheck one more time**

```bash
npm test && node scripts/selfcheck.mjs
```
Expected: 11/11 unit tests pass; selfcheck final line `OK`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add bin/wa.mjs README.md CHANGELOG.md
git commit -m "docs: document version targets; wa status shows the resolved target"
```

---

## Task 6: `scripts/vendor-proto.mjs` + refresh the `wa-master` proto

**Files:**
- Create: `scripts/vendor-proto.mjs`
- Create: `proto/wa-master/messages.proto` (+ any `JsonMessages` the hash recipe needs, if the script vendors them alongside)

**Interfaces:**
- Produces: `node scripts/vendor-proto.mjs <git-ref> [name]` — writes `proto/<name>/messages.proto` (name defaults to a slug of the ref) and prints the computed `apiVersionHash`.

- [ ] **Step 1: Create `scripts/vendor-proto.mjs`**

```js
// Vendor WorkAdventure's proto for a given git ref and compute its
// apiVersionHash, so a new adapter can be pinned.
//
//   node scripts/vendor-proto.mjs master wa-master
//   node scripts/vendor-proto.mjs v1.34.0 wa-1.34
//
// Requires `git` on PATH and network access to github.com. Falls back to a
// clear message pointing at the manual recipe in README § apiVersionHash.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const [ref, nameArg] = process.argv.slice(2);
if (!ref) {
  console.error("usage: node scripts/vendor-proto.mjs <git-ref> [name]");
  process.exit(2);
}
const name = nameArg || ref.replace(/[^A-Za-z0-9._-]/g, "-");
const root = path.join(fileURLToPath(new URL("..", import.meta.url)));
const outDir = path.join(root, "proto", name);

const sh = (cmd, args, opts) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], ...opts });

let work;
try {
  work = mkdtempSync(path.join(tmpdir(), "wa-proto-"));
  console.error(`cloning workadventure@${ref} …`);
  sh("git", ["clone", "--depth", "1", "--branch", ref, "https://github.com/workadventure/workadventure.git", work], { stdio: "inherit" });
} catch {
  // --branch fails for a bare sha; clone default then checkout
  sh("git", ["clone", "https://github.com/workadventure/workadventure.git", work], { stdio: "inherit" });
  sh("git", ["-C", work, "checkout", ref], { stdio: "inherit" });
}

mkdirSync(outDir, { recursive: true });
const protoSrc = path.join(work, "messages", "protos", "messages.proto");
copyFileSync(protoSrc, path.join(outDir, "messages.proto"));

// apiVersionHash = sha1( sha1sum(messages.proto  JsonMessages/*) ) first 8 hex
const jsonDir = path.join(work, "libs", "messages", "src", "JsonMessages");
const files = [protoSrc, ...readdirSync(jsonDir).sort().map((f) => path.join(jsonDir, f))];
const inner = files
  .map((f) => `${crypto.createHash("sha1").update(readFileSync(f)).digest("hex")}  ${path.basename(f)}`)
  .join("\n") + "\n";
const hash = crypto.createHash("sha1").update(inner).digest("hex").slice(0, 8);

writeFileSync(path.join(outDir, "SOURCE"), `ref: ${ref}\nvendored: ${new Date().toISOString()}\napiVersionHash: ${hash}\n`);
console.log(`\nproto/${name}/messages.proto written`);
console.log(`apiVersionHash: ${hash}   → put this in adapters/${name}.mjs apiVersionHashes`);
```

- [ ] **Step 2: Run it for master**

Run: `node scripts/vendor-proto.mjs master wa-master`
Expected: `proto/wa-master/messages.proto` + `proto/wa-master/SOURCE` written; prints an 8-hex `apiVersionHash`.

- [ ] **Step 3: Reconcile the hash with the adapter**

If the printed hash differs from `wa-master.mjs`'s `apiVersionHashes: ["907396a8"]`, update that array to `[<printed hash>]` and set `trackedSha` to the short sha from `proto/wa-master/SOURCE` (run `git -C <clone> rev-parse --short HEAD` — or read it from the clone before it's gone; simplest: `node scripts/vendor-proto.mjs` already recorded `ref: master`, so also capture the resolved sha — add a line to the script: `const sha = sh("git", ["-C", work, "rev-parse", "--short", "HEAD"]).toString().trim();` and include it in `SOURCE` and the stdout).

- [ ] **Step 4: Verify the master proto loads**

Run:
```bash
node -e '
import("protobufjs").then(async (pb) => {
  const r = await pb.load("proto/wa-master/messages.proto");
  console.log("ClientToServerMessage:", !!r.lookupType("ClientToServerMessage"));
  console.log("ServerToClientMessage:", !!r.lookupType("ServerToClientMessage"));
});
'
```
Expected: both `true`.

- [ ] **Step 5: Unit tests still green**

Run: `npm test`
Expected: 11/11 (Task 2 tests reference `trackedSha` `"7d628838"` in two assertions — if Step 3 changed `trackedSha`, update those two test literals to match).

- [ ] **Step 6: Commit**

```bash
git add scripts/vendor-proto.mjs proto/wa-master/ src/adapters/wa-master.mjs test/adapters.test.mjs
git commit -m "vendor-proto script; pin wa-master proto + hash at tracked sha"
```

---

## Task 7: Live-verify `wa-master` against staging

Not a code task — a verification gate. Produces the `verified` record in `wa-master.mjs`.

- [ ] **Step 1: selfcheck against staging**

Run: `node scripts/selfcheck.mjs --target wa-master --room https://play.staging.workadventu.re/@/tcm/workadventure/wa-village`
Expected: `connect + join`, `adapter resolved` (`wa-master`), `apiVersionHash accepted`, `move`, `speech bubble` all `PASS`. `area meeting` / `audio` `SKIP` or `FAIL` — record which.

Note: staging requires a staging-valid `wokaId`. If `connect` fails with `invalid character texture`, pass `--room` plus set `WA_WOKA_ID` to a staging woka id (the design notes `62b0c71f-f396-432b-a4c8-4d369d73e766` "Leo"), and re-run. Capture this requirement in the `verified` block.

- [ ] **Step 2: Update `wa-master.mjs` `verified`**

Set `verifiedDate` to today and `verified.ok` / `verified.broken` to what Step 1 actually showed. Keep `broken: ["proximity audio — red mic / #10 mic-state race"]` unless staging audio now works.

- [ ] **Step 3: Confirm prod is untouched**

Run: `node scripts/selfcheck.mjs`
Expected: final line `OK`, exit 0 — `wa-master` work changed nothing on the prod path.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/wa-master.mjs
git commit -m "wa-master: record live-verified state against staging"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 adapter objects (`wa-helpers`, `wa-1.33`, `wa-master`) | 1, 2 |
| §1 `wa-1.33` shape — every mechanical + behavioural key | 1 (Step 2) |
| §1 `shortHash`/`slugify` → `wa-helpers.mjs` | 1 (Step 1), 3 (Step 2 removes originals) |
| §2 `resolveAdapter` precedence (override / probe / allowlist / default) | 2 (Step 4) + tests (Step 2) |
| §2 `probeVersion` (GET origin, `AbortSignal.timeout(8000)`, null on failure) | 2 (Step 4) |
| §2 unknown minor → newest released + warn | 2 (test 7) |
| §2 master sha drift → warn naming both shas | 2 (test 9), 6 |
| §2 explicit `WA_VERSION` still wins in `_wsUrl()` | 3 (Step 4, `this.cfg.version || …`) |
| §3 client wiring — proto path, hash, endpoints, space-join, area-name, mic mask, envelope guard | 3 (Steps 2–5) |
| §3 `WaAudio` reads `client.adapter` | 3 (Step 5) |
| §4 config — `WA_TARGET`, `version` default null, `configToEnv` | 3 (Step 6) |
| §5 daemon — pass `target`, `state().target`, reconnect re-resolves | 3 (Step 7) |
| §6 CLI — `--target`, `wa selfcheck`, status line | 4, 5 (Step 1) |
| §7 `wa selfcheck` step table (connect / adapter match / move / bubble / area / audio best-effort) | 4 (Step 1) |
| §7 prod selfcheck is the merge gate | 5 (Step 3 README), Global Constraints |
| §8 `scripts/vendor-proto.mjs` + proto move to `proto/wa-1.33/` | 6, 3 (Step 1) |
| §8 `proto/wa-master/` vendored at trackedSha | 6 |
| Stage 1 no-op verified against afrolabs | 3 (Step 9), 4 (Step 3) |
| Stage 3 re-run staging intro / record ok+broken | 7 |
| §Risks — extraction in its own PR, probe logs why, host allowlist catch | Task 3 is one commit; 2 (why strings); 2 (allowlist) |

No gaps. (The spec's four "stages" map to task groups: Stage 1 = Tasks 1–4, Stage 2 = Tasks 2+4+5 detection/surfacing, Stage 3 = Tasks 6–7, Stage 4 = Task 5 docs. The plan orders them so each task ends green.)

**2. Placeholder scan**

No "TBD"/"TODO"/"handle edge cases"/"similar to Task N". Every code step has real code. Task 6 Step 3 and Task 7 Steps 1–2 are deliberately conditional ("if the hash differs", "record what Step 1 showed") because they reconcile against a live server whose exact response can't be known when writing the plan — each spells out the exact edit to make in each branch.

**3. Type consistency**

- Adapter object keys defined in Task 1 Step 2 are used verbatim in Task 3 Steps 4–5 and Task 5 Step 1: `apiVersionHashes` (array, `[0]` indexed), `protoPath`, `endpoints.anonymLogin`/`.map`, `spaceJoin.{filterType,defaultPropsToSync,watchViaAddSpaceFilter,micReannounceMs}`, `areaMeetingSpaceName(roomUrl, prop)`, `micState.updateMaskPaths`/`.speakingMaskPaths`, `meeting.webrtcStrategyName`, `envelope`, `id`, `waVersion`, `stability`, `verified`. Consistent.
- `resolveAdapter` return `{adapter, why, warn?}` — Task 2 tests read `.adapter.id`, `.why`, `.warn`; Task 3 Step 3 destructures `{adapter, why, warn}`. Consistent.
- `client.adapter` set by `connect()` (Task 3 Step 3), read by `WaAudio` (Task 3 Step 5), `selfcheck` (Task 4 Step 1), `state()` (Task 3 Step 7). Consistent.
- `resolveConfig().target` (Task 3 Step 6) consumed by daemon (Task 3 Step 7) and `selfcheck` (Task 4 Step 1). Consistent.
- `matchVersion` return shape `{kind:"release",minor,raw}` / `{kind:"master",sha,raw}` / `null` — produced in Task 2 Step 4, consumed by `resolveAdapter` in the same file and by tests in Step 2. Consistent.

No mismatches found.
