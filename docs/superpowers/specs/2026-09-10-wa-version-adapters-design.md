# WorkAdventure version adapters

**Status:** approved (design conversation 2026-09-10)
**Scope:** a version-target seam so the client can talk to more than one
WorkAdventure build without prod behaviour and staging behaviour fighting each
other.

## Problem

Everything about talking to a WorkAdventure server is reverse-engineered and
pinned to one build:

- `DEFAULTS.version = "bfd20fc4"` — the `apiVersionHash` for prod's `v1.33.5`.
  A mismatch closes the socket with a "new version" screen.
- `proto/messages.proto` — vendored from tag `v1.33.5`, no override.
- Endpoint paths (`/anonymLogin`, `/map`, `/woka/list`), the `/woka/list` auth
  header shape (bare token, no `Bearer`), the default woka id, the undocumented
  outer envelope, the space-join handshake, the area-meeting space-name
  derivation, the mic-state `updateMask` semantics — all inlined in
  `wa-client.mjs` / `wa-audio.mjs` with no version guard.

We now run against two builds:

| server | reports | versioning |
|---|---|---|
| `play.workadventu.re` (afrolabs, lean-iterator, tcm — one prod host) | `v1.33.5` | semver tag |
| `play.staging.workadventu.re` | `master@<sha>` | untagged rolling `master`; the sha moves between sessions |

A proto diff (`v1.33.5` vs `master@7c5ff99b`) showed changes **only** in
VideoQuality analytics messages — nothing in Space / SpaceUser / Emote / Sub. So
the builds are behaviourally close today, but the compat surface is scattered
and unlabelled, and chasing a staging fix risks regressing the working prod
path.

## Goals

1. One named **adapter per WA `major.minor`** (not per patch) carrying every
   build-specific constant and behaviour.
2. The client **auto-detects** the target from the server and picks the adapter;
   an explicit override always wins.
3. **`wa-1.33` (prod) is frozen** after extraction. Staging/`master` work lives
   entirely in `wa-master.mjs` and never edits shared core or `wa-1.33`.
4. A **prod smoke test** (`wa selfcheck --target production`) that must stay
   green across any change.

## Non-goals

- Supporting arbitrary historical WA versions. Only the adapters we ship.
- A full protocol abstraction layer. The envelope framing and the S2C dispatch
  `switch` stay in the client for now (one implementation each) — the adapter
  carries a version *tag* the client asserts against, and the code moves down
  only when a second form actually appears (YAGNI).
- Making `master` a stability-guaranteed target. It is maintained but
  best-effort; a red `selfcheck --target master` is a known-issues note, never a
  merge blocker.

## Design

### 1. Adapter objects — `src/adapters/`

Each adapter is a plain object. `wa-1.33.mjs` is the baseline; `wa-master.mjs`
spreads it and overrides.

```
src/adapters/
  index.mjs      registry + resolveAdapter() + probeVersion()
  wa-1.33.mjs    baseline — today's constants, verbatim
  wa-master.mjs  import base from "./wa-1.33.mjs"; export { ...base, <overrides> }
```

**`wa-1.33.mjs` shape** (values are exactly what the code uses today):

```js
export default {
  id: "wa-1.33",
  waVersion: "1.33",                 // major.minor this adapter targets
  stability: "frozen",               // "frozen" | "tracking"

  // --- mechanical ---
  apiVersionHashes: ["bfd20fc4"],    // a SET: a patch can shift the hash with no
                                     // behaviour change -> append, don't fork
  protoPath: "proto/wa-1.33/messages.proto",
  defaultWokaId: "506a3a64-47a9-4587-b19b-2d1eb13f9790",
  endpoints: { anonymLogin: "/anonymLogin", map: "/map", wokaList: "/woka/list" },
  wokaListAuthHeader: (token) => ({ Authorization: token }),  // bare, no "Bearer"
  envelope: "seq-len-v1",            // asserted by the client; framing code stays there

  // --- behaviours ---
  spaceJoin: {
    filterType: 0,                                   // ALL_USERS
    defaultPropsToSync: ["cameraState", "microphoneState", "screenSharingState"],
    watchViaAddSpaceFilter: true,                    // send addSpaceFilterMessage after join
    micReannounceMs: [0, 1000, 3000],               // #10 mitigation cadence
  },
  areaMeetingSpaceName: (roomUrl, prop) =>
    slugify(shortHash(roomUrl) + "-" +
      (prop.roomName?.trim() ? prop.roomName : prop.id)),
  emote: { wireFormat: "emoji-string", channel: "sub.emoteEventMessage" },
  micState: {
    updateMaskPaths: ["microphoneState"],
    speakingMaskPaths: ["showVoiceIndicator", "microphoneState"],
  },
  meeting: { webrtcStrategyName: "WEBRTC" },
};
```

`shortHash` / `slugify` move from `wa-client.mjs` into a small
`src/adapters/wa-helpers.mjs` (ports of WA's `libs/shared-utils`) so an adapter
can call them.

**`wa-master.mjs`** — initially only the mechanical drift:

```js
import base from "./wa-1.33.mjs";
export default {
  ...base,
  id: "wa-master",
  waVersion: "master",
  stability: "tracking",
  trackedSha: "7d628838",
  verifiedDate: "2026-09-10",
  verified: {
    ok: ["join", "move", "bubble", "emote"],
    broken: ["proximity audio — red mic / #10 mic-state race"],
  },
  apiVersionHashes: ["907396a8"],   // recomputed at trackedSha; stale if sha moves
  protoPath: "proto/wa-master/messages.proto",
  // behavioural overrides added here as they are discovered — none needed yet
};
```

### 2. Resolution — `src/adapters/index.mjs`

```
resolveAdapter({ roomUrl, override }) -> { adapter, why }
```

Precedence:

1. **`override`** (`--target` / `WA_TARGET` / `cfg.target`, when not `"auto"`) —
   look up by `id`; throw a clear error if unknown. `why = "explicit override"`.
2. **Probe** — `GET <origin-of-roomUrl>/`, scrape the served HTML:
   - `/v(\d+)\.(\d+)\.\d+/` → key `wa-<maj>.<min>`.
     - exact adapter exists → use it.
     - no adapter for that minor → **newest released adapter** + loud warn
       (`WA 1.34 unverified — using wa-1.33 behaviours`).
   - `/master@([0-9a-f]{7,40})/` → `wa-master`. If `sha !== adapter.trackedSha`,
     load it anyway with a warn (`tracked master@7d628838 (2026-09-10), server on
     master@abc1234 — behaviours may have drifted`).
   - `why = "probed v1.33.5 from play.workadventu.re"`.
3. **Host allowlist** — `{ "play.workadventu.re": "wa-1.33" }`. `why = "host
   allowlist"`.
4. **Default** `wa-1.33` + warn. `why = "default (probe failed)"`.

`probeVersion` uses `fetch` with `AbortSignal.timeout(8000)`; any failure falls
through to step 3.

An explicit `WA_VERSION` (apiVersionHash) still wins over
`adapter.apiVersionHashes[0]` in `_wsUrl()` — kept for one-off probing of a new
build before it has an adapter.

### 3. Client wiring — `src/wa-client.mjs`

- Constructor accepts `opts.adapter` (object) or `opts.target` (string, default
  from cfg). Stores `this.adapter = opts.adapter ?? null`, `this._target =
  opts.target ?? "auto"`.
- `connect()` first step: `this.adapter ??= (await resolveAdapter({ roomUrl:
  this.cfg.roomUrl, override: this._target })).adapter`; emit a `log` line with
  `adapter.id` + `why`.
- `_loadProto()` → `path.join(__dirname, "..", this.adapter.protoPath)`.
- `_wsUrl()` → `version` param = `this.cfg.version` if explicitly set, else
  `this.adapter.apiVersionHashes[0]`.
- `_anonymLogin` / `_loadAreas` → `this.adapter.endpoints.*`.
- `_joinSpace` → reads `filterType`, `defaultPropsToSync`,
  `watchViaAddSpaceFilter`, `micReannounceMs` from `this.adapter.spaceJoin`.
- `_areaSpaceName(prop)` → `this.adapter.areaMeetingSpaceName(this.cfg.roomUrl,
  prop)`.
- `setSpaceMicState` / (via a tiny accessor) `WaAudio._setSpeaking` → mask paths
  from `this.adapter.micState`.
- `_wrap`/`_unwrap` unchanged; add
  `if (this.adapter.envelope !== "seq-len-v1") throw` as a guard.
- The woka-list fetch (currently only in a throwaway script / notes) uses
  `this.adapter.wokaListAuthHeader`.

`WaAudio` reads `this.client.adapter` where it needs `micState` /
`meeting.webrtcStrategyName`.

### 4. Config — `src/config.mjs`

- `ENV_MAP`: add `WA_TARGET: "target"`.
- `BASE.target = "auto"`.
- `configToEnv`: mirror `WA_TARGET: cfg.target`.
- `version` stays as-is (explicit hash override).

### 5. Daemon — `src/wa-daemon.mjs`

- Construct the client with `target: cfg.target` (still pass `version` when
  explicitly set).
- `state()` gains
  `target: { id, waVersion, stability, why, verified }`.
- `attemptReconnect()` re-resolves the adapter (the server may have been
  upgraded between the drop and the reconnect) — it already builds a fresh
  client, so just pass `target: cfg.target` and let `connect()` resolve.

### 6. CLI — `bin/wa.mjs`

- `--target <id>` flag → threaded into `resolveConfig({ target })` for `join`,
  and sent to the daemon where relevant.
- `wa status` / `prettyStatus`: show `target: wa-1.33 (probed v1.33.5 …)`.
- `wa selfcheck [--target <id>]` — see §7.

### 7. `wa selfcheck` — `scripts/selfcheck.mjs`, exposed as `wa selfcheck`

An ephemeral client (not the daemon), against the resolved target's default
room (or `--room`):

| step | pass condition |
|---|---|
| resolve + connect | `roomJoinedMessage` within 15 s |
| adapter match | server didn't send a `NEW_VERSION` errorScreen |
| move | walk +64 px, position echo received |
| bubble | `speechBubble` then `clearBubble` without error |
| area meeting | walk into a known `livekitRoomProperty` area, `joinSpaceAnswer` received |
| audio (best-effort) | if a peer connects, play a 1 s clip; **skipped, not failed,** with no peer |

Prints `PASS`/`FAIL`/`SKIP` per step, exits non-zero on any `FAIL`.

**Merge gate:** `wa selfcheck --target production` green before and after any
change touching `src/`. `--target master` is advisory. This goes in
`CONTRIBUTING` / the PR checklist; not automated CI in this pass.

### 8. Proto vendoring — `scripts/vendor-proto.mjs <ref> [name]`

- `git`-clones (or `fetch`es the raw files from) `workadventure` at `<ref>`,
  copies `messages/protos/messages.proto` +
  `libs/messages/src/JsonMessages/*.ts` into `proto/<name>/` (`name` defaults to
  a slug of the ref).
- Computes the `apiVersionHash`
  (`sha1( sha1sum(messages.proto JsonMessages/*) )` → first 8 hex) and prints
  it, so it can be pasted into the adapter's `apiVersionHashes`.
- Network-dependent; the README already documents the manual recipe as a
  fallback.

The existing `proto/messages.proto` **moves to `proto/wa-1.33/messages.proto`**
(update `.gitignore` / any references). `proto/wa-master/messages.proto` is
vendored at `trackedSha`.

## Implementation stages (separate PRs)

1. **Extraction (no-op refactor).** Add `src/adapters/` with `wa-1.33.mjs` +
   `index.mjs` (resolver defaulting hard to `wa-1.33`, no probe yet), move the
   proto to `proto/wa-1.33/`, wire `wa-client` / `wa-audio` / `config` /
   `daemon` to read every pinned value from the adapter. **Verification:**
   behaviour against afrolabs is byte-identical — `wa selfcheck` (added here,
   minimal) and a manual `wa sound` into a bubble both pass exactly as before.
2. **Detection.** `probeVersion` + the 4-step fallback chain, `--target` /
   `WA_TARGET`, daemon `state().target`, `wa status` line. Default room still
   resolves to `wa-1.33`.
3. **`wa-master` adapter.** `scripts/vendor-proto.mjs`, `proto/wa-master/`,
   `wa-master.mjs`. Staging becomes `--target wa-master` (or auto-detected).
   Re-run the staging intro; record what's `ok` / `broken` in the adapter's
   `verified` block.
4. **`selfcheck` hardening + docs.** Flesh out the step table, the area-meeting
   and best-effort audio legs, wire it into `CONTRIBUTING` as the merge gate,
   document targets + detection in `README` (`## Version targets`) and
   `CHANGELOG`.

## Risks

- **Extraction regresses prod.** Mitigated by doing it as a pure no-op in its
  own PR, verified against afrolabs before any `master` work.
- **Probe HTML format changes** and detection silently falls back. Mitigated:
  the fallback always logs *why*, `wa status` shows it, and the host allowlist
  catches prod regardless.
- **`master` moves and the hash goes stale** → `NEW_VERSION` on connect. The
  error message will name the detected version and the adapter's hash set so
  it's obvious the adapter needs a `vendor-proto` refresh; prod is unaffected.
