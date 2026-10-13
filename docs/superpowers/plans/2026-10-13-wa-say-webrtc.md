# `wa say` slice 2 (WebRTC mesh path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wa say <text>` makes the avatar speak aloud to peers on the WEBRTC mesh transport, streaming huggingsesame's `say.py --pcm-out` PCM through ffmpeg Opus encoding into the existing RTP path.

**Architecture:** `src/say.mjs` runs `say.py` into a persistent ffmpeg (PCM -> Ogg/Opus) and yields packets through a new incremental Ogg demuxer. `WaAudio._pump()` (extracted from `_playWebrtc`) paces any packet iterable out as RTP, with a prebuffer and underrun-to-new-talkspurt handling. `WaAudio.say()` ties them together under the existing `_play` token; the daemon and CLI get `/say`, `/say-cancel`, `wa say`.

**Tech Stack:** Node >= 18 ESM, `node --test`, werift (RTP), ffmpeg (libopus), Python `say.py` from `/Users/campey/Code/huggingsesame`.

**Spec:** `docs/superpowers/specs/2026-10-13-wa-say-webrtc-design.md`. Issue: #7 (this slice leaves it open; the PR says `Refs #7`).

## Global Constraints

- `say.py --pcm-out` stdout is raw PCM, **24 kHz mono s16le**; nothing else on stdout; logs on stderr (`--quiet` silences).
- Encode with exactly `ffmpeg -f s16le -ar 24000 -ac 1 -i pipe:0 -c:a libopus -frame_duration 20 -page_duration 20000 -flush_packets 1 -f ogg pipe:1` (`page_duration` is essential, otherwise ~1 s of latency).
- Prebuffer ~500 ms (25 packets of 20 ms); an underrun starts a new talkspurt.
- Text is passed to `say.py` on **stdin** (`-`), never argv.
- Do not reimplement any TTS logic (grouping, chaining, QC, leveling) in Node.
- Cancel = SIGTERM both child processes; no `say.py`, `mimi_sidecar.py` or `ffmpeg` may be left behind.
- Reuse the `_play` token guard and `_setSpeaking`; `wa sound` behaviour and result shape must not change.
- Config names: `WA_TTS_PYTHON` (default `python3`), `WA_TTS_SAY` (default `~/Code/huggingsesame/src/say.py`). The API token is never read, logged or passed by this repo.
- Repo rules (CLAUDE.md): work in the `wa-say` worktree; test daemons use a non-default port and avatar name `wa-say`; PR body uses `Refs #7`; merge with `--merge`, never squash; commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

Input classes the spec implies but no happy-path test would hit, most likely first. Each has a pinning test in the task that owns the code.

1. Text with quotes, `$()`, leading `-`, newlines, emoji: must reach `say.py` byte-for-byte (Task 3, "text reaches say.py intact").
2. `say.py` exits non-zero with no audio (bad token, cloud failure): `say()` resolves `played:false` with the reason, never an unhandled rejection or a lit speaking indicator (Task 3 + Task 4).
3. `ffmpeg` or `python3` missing (spawn ENOENT): same graceful result, no daemon crash (Task 3).
4. Cancel/supersede/hang-up while `say.py` is still cold-starting (no PCM yet): children die, nothing orphaned (Task 3 + Task 4).
5. All peers gone by the time audio arrives, or an utterance shorter than the prebuffer: no speaking indicator for nobody; short clips still flush (Task 2).

---

### Task 1: Incremental Ogg/Opus demuxer

**Files:**
- Modify: `src/ogg-opus.mjs` (export `opusSamples`)
- Create: `src/ogg-stream.mjs`
- Test: `test/ogg-stream.test.mjs`

**Interfaces:**
- Consumes: `opusSamples(pkt: Buffer): number` from `src/ogg-opus.mjs`; `muxOggOpus(packets)` from `src/ogg-opus-mux.mjs` (tests only).
- Produces: `oggOpusPackets(chunks: AsyncIterable<Buffer>): AsyncGenerator<{data: Buffer, samples: number}>`.

- [ ] **Step 0: Make sure the worktree has dependencies**

Run: `[ -d node_modules ] || npm ci`
Expected: `node_modules` exists afterwards.

- [ ] **Step 1: Write the failing test**

Create `test/ogg-stream.test.mjs`:

```js
// The streaming Ogg/Opus demuxer must agree with the whole-file reader no
// matter how the byte stream is chunked (ffmpeg's pipe delivers arbitrary
// slices), including packets that span lacing values and pages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readOggOpus } from "../src/ogg-opus.mjs";
import { muxOggOpus } from "../src/ogg-opus-mux.mjs";
import { oggOpusPackets } from "../src/ogg-stream.mjs";

async function collect(it) {
  const out = [];
  for await (const p of it) out.push(p);
  return out;
}

async function* chunked(buf, size) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(i + size, buf.length));
}

function assertSame(got, want, label) {
  assert.equal(got.length, want.length, `${label}: packet count`);
  got.forEach((p, i) => {
    assert.ok(p.data.equals(want[i].data), `${label}: packet ${i} bytes`);
    assert.equal(p.samples, want[i].samples, `${label}: packet ${i} samples`);
  });
}

test("matches readOggOpus for a real clip at several chunk sizes", async () => {
  const { packets } = await readOggOpus("sounds/chime.ogg");
  const ogg = muxOggOpus(packets);
  for (const size of [1, 7, 27, 255, 1000, ogg.length]) {
    assertSame(await collect(oggOpusPackets(chunked(ogg, size))), packets, `chunk ${size}`);
  }
});

test("reassembles packets that cross lacing values and exact multiples of 255", async () => {
  const mk = (n, fill) => {
    const data = Buffer.alloc(n, fill);
    data[0] = 0x78; // TOC: 20 ms, code 0 -> 960 samples
    return { data, samples: 960 };
  };
  const packets = [mk(600, 1), mk(255, 2), mk(510, 3), mk(10, 4)];
  const ogg = muxOggOpus(packets);
  for (const size of [1, 13, 300, ogg.length]) {
    assertSame(await collect(oggOpusPackets(chunked(ogg, size))), packets, `chunk ${size}`);
  }
});

test("a truncated tail yields the complete packets and does not throw", async () => {
  const { packets } = await readOggOpus("sounds/chime.ogg");
  const ogg = muxOggOpus(packets);
  const got = await collect(oggOpusPackets(chunked(ogg.subarray(0, ogg.length - 5), 100)));
  assert.ok(got.length > 0 && got.length < packets.length);
  assertSame(got, packets.slice(0, got.length), "prefix");
});

test("non-Ogg input throws a clear error", async () => {
  await assert.rejects(
    collect(oggOpusPackets(chunked(Buffer.from("this is not an ogg stream at all!"), 10))),
    /bad Ogg/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ogg-stream.test.mjs`
Expected: FAIL, `Cannot find module '../src/ogg-stream.mjs'`.

- [ ] **Step 3: Implement**

In `src/ogg-opus.mjs` change `function opusSamples(pkt) {` to `export function opusSamples(pkt) {`.

Create `src/ogg-stream.mjs`:

```js
// Incremental Ogg/Opus demuxer: the streaming sibling of readOggOpus() for
// `wa say`, where ffmpeg's stdout arrives in arbitrary slices while the clip is
// still being generated. Page layout and lacing are documented in
// ogg-opus.mjs; the difference here is that a page is only parsed once all of
// it has arrived, and a packet that ends a page on a 255 lacing value is
// carried into the next page.

import { opusSamples } from "./ogg-opus.mjs";

const isHeader = (data) => {
  const tag = data.toString("latin1", 0, 8);
  return tag === "OpusHead" || tag === "OpusTags";
};

/**
 * @param {AsyncIterable<Buffer>} chunks  raw bytes of an Ogg/Opus stream
 * @returns {AsyncGenerator<{data: Buffer, samples: number}>}
 */
export async function* oggOpusPackets(chunks) {
  let buf = Buffer.alloc(0);
  let carry = null; // partial packet spanning a page boundary
  for await (const chunk of chunks) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    let pos = 0;
    for (;;) {
      if (buf.length - pos < 27) break;
      if (buf.toString("latin1", pos, pos + 4) !== "OggS") {
        throw new Error("bad Ogg stream: missing OggS capture pattern");
      }
      const segCount = buf[pos + 26];
      const headerLen = 27 + segCount;
      if (buf.length - pos < headerLen) break;
      let bodyLen = 0;
      for (let i = 0; i < segCount; i++) bodyLen += buf[pos + 27 + i];
      if (buf.length - pos < headerLen + bodyLen) break;

      let dp = pos + headerLen;
      let parts = carry ? [carry] : [];
      carry = null;
      for (let i = 0; i < segCount; i++) {
        const lace = buf[pos + 27 + i];
        parts.push(buf.subarray(dp, dp + lace));
        dp += lace;
        if (lace < 255) {
          const data = Buffer.concat(parts); // copies, so `buf` can be released
          parts = [];
          if (data.length && !isHeader(data)) yield { data, samples: opusSamples(data) };
        }
      }
      carry = parts.length ? Buffer.concat(parts) : null;
      pos += headerLen + bodyLen;
    }
    buf = buf.subarray(pos);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ogg-stream.test.mjs`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ogg-opus.mjs src/ogg-stream.mjs test/ogg-stream.test.mjs
git commit -m "$(cat <<'EOF'
feat: incremental Ogg/Opus demuxer for streamed speech (#7)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extract `_pump` from `_playWebrtc` (prebuffer + underrun)

**Files:**
- Modify: `src/wa-audio.mjs` (constants near line 52; `_playWebrtc` at ~726-808; new `_pump`, `_connectedPeers`)
- Test: `test/wa-audio-pump.test.mjs`

**Interfaces:**
- Consumes: peer shape `{ pc:{connectionState}, track:{writeRtp}, ssrc, seq, ts, lastPlayEnd }`; `this._setSpeaking(on, indicator)`.
- Produces:
  - `WaAudio#_connectedPeers(): Peer[]`
  - `WaAudio#_pump(source, { getTargets: () => Peer[], isStopped: () => boolean, indicator?: boolean, prebuffer?: number }): Promise<{ packetsSent, writeErrors, peers, peerStates, firstSendAt: number|null, reason?: string }>` where `source` is an array or (async) iterable of `{data: Buffer, samples: number}`. `reason` is set only when nothing was sent (`"superseded"`, `"no connected peers"`, `"empty"`).
  - Exported-for-module constants `PUMP_PREBUFFER_PACKETS = 25`, `PUMP_UNDERRUN_MS = 60`.

- [ ] **Step 1: Write the failing test**

Create `test/wa-audio-pump.test.mjs`:

```js
// _pump: the shared RTP pacing loop behind both file playback and `wa say`.
// Real timers with generous tolerances (a fake clock would not exercise
// performance.now()/sleep the way production does).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { WaAudio } from "../src/wa-audio.mjs";

function fakeClient() {
  const c = new EventEmitter();
  c.micOn = true;
  c.spaces = new Map([["s1", { spaceUserId: "u1" }]]);
  c.sent = [];
  c._send = (m) => c.sent.push(m);
  c.query = async () => ({ iceServersAnswer: { iceServers: [] } });
  c.adapter = { micState: { speakingMaskPaths: ["showVoiceIndicator", "microphoneState"] } };
  return c;
}

function fakePeer(onWrite) {
  const rtp = [];
  return {
    pc: { connectionState: "connected", close() {} },
    track: { writeRtp: (pkt) => { rtp.push(pkt); onWrite?.(rtp.length); } },
    spaceName: "s1", remoteUserId: "peer-1", ssrc: 1, seq: 0, ts: 0,
    lastPlayEnd: performance.now(),
    _rtp: rtp,
  };
}

const pkt = (i) => ({ data: Buffer.from([0x78, i & 0xff]), samples: 960 });
const speaking = (client) =>
  client.sent.filter((m) => m.updateSpaceUserMessage).map((m) => m.updateSpaceUserMessage.user.showVoiceIndicator);

test("file-style array: all packets, marker on the first only, contiguous timestamps, ~20 ms pacing", async () => {
  const audio = new WaAudio(fakeClient());
  const peer = fakePeer();
  const t0 = performance.now();
  const r = await audio._pump(Array.from({ length: 10 }, (_, i) => pkt(i)), {
    getTargets: () => [peer], isStopped: () => false,
  });
  const took = performance.now() - t0;
  assert.equal(r.packetsSent, 10);
  assert.equal(peer._rtp.length, 10);
  assert.deepEqual(peer._rtp.map((p) => p.header.marker), [true, ...Array(9).fill(false)]);
  for (let i = 1; i < 10; i++) {
    assert.equal(peer._rtp[i].header.timestamp - peer._rtp[i - 1].header.timestamp, 960);
  }
  assert.ok(took > 150 && took < 600, `10 x 20 ms paced in ${took.toFixed(0)} ms`);
  assert.deepEqual(speaking(audio.client), [true, false]);
});

test("prebuffer holds the first RTP packet until N packets have been pulled", async () => {
  async function* gen(state) {
    for (let i = 0; i < 10; i++) { await sleep(5); state.pulled++; yield pkt(i); }
  }
  const run = async (prebuffer) => {
    const state = { pulled: 0 };
    let pulledAtFirstWrite = null;
    const peer = fakePeer((n) => { if (n === 1) pulledAtFirstWrite = state.pulled; });
    const audio = new WaAudio(fakeClient());
    await audio._pump(gen(state), { getTargets: () => [peer], isStopped: () => false, prebuffer });
    return pulledAtFirstWrite;
  };
  assert.ok((await run(5)) >= 5, "prebuffer 5");
  assert.equal(await run(0), 1, "control: no prebuffer sends as soon as the first arrives");
});

test("a stream shorter than the prebuffer still flushes at end", async () => {
  const audio = new WaAudio(fakeClient());
  const peer = fakePeer();
  const r = await audio._pump((async function* () { for (let i = 0; i < 3; i++) yield pkt(i); })(), {
    getTargets: () => [peer], isStopped: () => false, prebuffer: 25,
  });
  assert.equal(r.packetsSent, 3);
});

test("an underrun starts a new talkspurt: marker set and RTP timestamp jumps over the gap", async () => {
  async function* gen() {
    for (let i = 0; i < 5; i++) yield pkt(i);
    await sleep(250); // producer stalls
    for (let i = 5; i < 10; i++) yield pkt(i);
  }
  const audio = new WaAudio(fakeClient());
  const peer = fakePeer();
  await audio._pump(gen(), { getTargets: () => [peer], isStopped: () => false, prebuffer: 2 });
  const markers = peer._rtp.map((p) => p.header.marker);
  assert.equal(markers[0], true);
  assert.equal(markers[5], true, "first packet after the stall is a new talkspurt");
  assert.equal(markers.filter(Boolean).length, 2, "no other markers");
  const jump = peer._rtp[5].header.timestamp - peer._rtp[4].header.timestamp;
  assert.ok(jump > 960 + 48000 * 0.1, `timestamp advanced over the stall (${jump})`);
});

test("stop mid-stream: ends promptly, releases the source, and clears the speaking indicator last", async () => {
  let sourceClosed = false;
  async function* gen() {
    try { for (let i = 0; i < 1000; i++) yield pkt(i); } finally { sourceClosed = true; }
  }
  let stopped = false;
  const peer = fakePeer((n) => { if (n === 3) stopped = true; });
  const audio = new WaAudio(fakeClient());
  const r = await audio._pump(gen(), { getTargets: () => [peer], isStopped: () => stopped });
  assert.ok(r.packetsSent >= 3 && r.packetsSent <= 4, `sent ${r.packetsSent}`);
  assert.equal(sourceClosed, true, "producer's finally ran (this is what kills say.py)");
  assert.deepEqual(speaking(audio.client), [true, false]);
});

test("no connected peers once audio arrives: reports it and never lights the indicator", async () => {
  const audio = new WaAudio(fakeClient());
  const r = await audio._pump([pkt(0), pkt(1)], { getTargets: () => [], isStopped: () => false });
  assert.equal(r.packetsSent, 0);
  assert.equal(r.reason, "no connected peers");
  assert.deepEqual(speaking(audio.client), []);
});

test("an empty source reports 'empty' without lighting the indicator", async () => {
  const audio = new WaAudio(fakeClient());
  const r = await audio._pump([], { getTargets: () => [fakePeer()], isStopped: () => false });
  assert.equal(r.reason, "empty");
  assert.deepEqual(speaking(audio.client), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wa-audio-pump.test.mjs`
Expected: FAIL, `audio._pump is not a function`.

- [ ] **Step 3: Implement**

In `src/wa-audio.mjs`, after the `LIVEKIT_FRAME_MS` constant add:

```js
// Streaming playback (`say`): hold this many 20 ms packets before the first RTP
// goes out, and treat a packet arriving later than the underrun threshold as a
// new talkspurt rather than bursting to catch up.
const PUMP_PREBUFFER_PACKETS = 25; // 500 ms
const PUMP_UNDERRUN_MS = 60;
```

Replace the whole `_playWebrtc` method (from `async _playWebrtc(file, ...` to its closing brace, just before the `// LiveKit publish path (#8).` comment) with the following. Keep the existing explanatory comment about claiming `_play` synchronously.

```js
  _connectedPeers() {
    return [...this.peers.values()].filter((p) => p.pc.connectionState === "connected");
  }

  async _playWebrtc(file, { indicator = true } = {}) {
    // Claim `_play` synchronously, before any awaits, so a second concurrent
    // call (e.g. a real clip landing mid-prime, or two peers connecting a few
    // ms apart) sees "something is already starting" immediately instead of
    // racing past this guard during the ensureOpus/readOggOpus awaits (#10).
    this._play?.stop();
    let stopped = false;
    const token = (this._play = { stop: () => (stopped = true) });

    const opus = await ensureOpus(file);
    const { packets, totalSamples } = await readOggOpus(opus);
    if (stopped) return { played: false, reason: "superseded" };
    if (!packets.length) {
      if (this._play === token) this._play = null;
      // A corrupt/truncated cache entry demuxes to zero packets — invalidate
      // it so the next call re-encodes instead of re-hitting the same broken
      // file forever (#10; no-ops for a caller-supplied path, see transcode.mjs).
      await invalidateCache(opus);
      return { played: false, reason: "empty clip" };
    }

    const targets = this._connectedPeers();
    if (!targets.length) {
      if (this._play === token) this._play = null;
      return { played: false, reason: "no connected peers" };
    }

    const r = await this._pump(packets, {
      getTargets: () => targets,
      isStopped: () => stopped,
      indicator,
    });
    if (this._play === token) this._play = null;
    return {
      played: !stopped,
      seconds: +(totalSamples / 48000).toFixed(2),
      peers: r.peers,
      packetsSent: r.packetsSent,
      writeErrors: r.writeErrors,
      peerStates: r.peerStates,
    };
  }

  // Pace Opus packets out as RTP to `getTargets()` on the 20 ms wall clock.
  // `source` is an array or (async) iterable of { data, samples }. With
  // `prebuffer` > 0 (the streaming path, `say`) it first collects that many
  // packets so producer jitter doesn't glitch the start, and afterwards treats
  // a packet that arrives more than PUMP_UNDERRUN_MS late as the start of a new
  // talkspurt (marker bit, RTP timestamp advanced over the gap, clock
  // re-based) instead of bursting to catch up. prebuffer 0 (file playback)
  // keeps the original behaviour. Always closes `source`, which is what tears
  // down say.py/ffmpeg when playback is superseded.
  async _pump(source, { getTargets, isStopped, indicator = true, prebuffer = 0 }) {
    const it = source[Symbol.asyncIterator]?.() ?? source[Symbol.iterator]();
    let ended = false;
    const pull = async () => {
      if (ended) return null;
      const r = await it.next();
      if (r.done) {
        ended = true;
        return null;
      }
      return r.value;
    };
    const none = (reason) => ({
      packetsSent: 0, writeErrors: 0, peers: 0, peerStates: [], firstSendAt: null, reason,
    });
    const queue = [];
    try {
      while (queue.length < prebuffer && !isStopped()) {
        const first = await pull();
        if (!first) break;
        queue.push(first);
      }
      if (isStopped()) return none("superseded");
      const targets = getTargets();
      if (!targets.length) return none("no connected peers");
      if (!queue.length) {
        const first = await pull();
        if (!first) return none("empty");
        queue.push(first);
      }

      // Advance each peer's timestamp over the silent gap since its last clip so
      // the RTP clock stays wall-clock-continuous, and mark the first packet as
      // a new talkspurt (RFC 3551) so the receiver resyncs its jitter buffer.
      const now0 = performance.now();
      for (const p of targets) {
        const gapSamples = Math.round(((now0 - p.lastPlayEnd) / 1000) * 48000);
        p.ts = (p.ts + Math.max(0, gapSamples)) >>> 0;
      }
      this._setSpeaking(true, indicator);

      let sent = 0;
      let errs = 0;
      let marker = true;
      let firstSendAt = null;
      let startedAt = performance.now();
      let elapsedMs = 0;
      try {
        for (let pkt = queue.shift(); pkt; pkt = queue.shift() ?? (await pull())) {
          if (isStopped()) break;
          if (prebuffer > 0) {
            const lateMs = performance.now() - (startedAt + elapsedMs);
            if (lateMs > PUMP_UNDERRUN_MS) {
              const gap = Math.round((lateMs / 1000) * 48000);
              for (const p of targets) p.ts = (p.ts + gap) >>> 0;
              marker = true;
              startedAt = performance.now();
              elapsedMs = 0;
            }
          }
          for (const p of targets) {
            const header = new RtpHeader({
              payloadType: OPUS.payloadType,
              sequenceNumber: p.seq++ & 0xffff,
              timestamp: p.ts >>> 0,
              ssrc: p.ssrc,
              marker,
            });
            try {
              p.track.writeRtp(new RtpPacket(header, pkt.data));
              sent++;
            } catch (e) {
              errs++;
              if (errs === 1) this.emit("log", `writeRtp error: ${e.message}`);
            }
            p.ts = (p.ts + pkt.samples) >>> 0;
          }
          firstSendAt ??= performance.now();
          marker = false;
          elapsedMs += (pkt.samples / 48000) * 1000;
          const drift = startedAt + elapsedMs - performance.now();
          if (drift > 1) await sleep(drift);
        }
      } finally {
        const endAt = performance.now();
        for (const p of targets) p.lastPlayEnd = endAt;
        this._setSpeaking(false, indicator);
      }
      return {
        packetsSent: sent,
        writeErrors: errs,
        peers: targets.length,
        peerStates: targets.map((p) => p.pc.connectionState),
        firstSendAt,
      };
    } finally {
      await it.return?.();
    }
  }
```

- [ ] **Step 4: Run the new tests and the whole suite (regression for `wa sound` / prime)**

Run: `node --test test/wa-audio-pump.test.mjs && npm test`
Expected: the 7 new tests PASS; the full suite passes, including `wa-audio-prime` and `wa-audio-ice-race`, which exercise `_playWebrtc` through the pump.

- [ ] **Step 5: Commit and report progress on the issue**

```bash
git add src/wa-audio.mjs test/wa-audio-pump.test.mjs
git commit -m "$(cat <<'EOF'
refactor: extract _pump from _playWebrtc, add prebuffer + underrun talkspurts (#7)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
gh issue comment 7 --repo campey/workadventurer --body "Slice 2 progress: incremental Ogg demuxer (\`src/ogg-stream.mjs\`) and \`WaAudio._pump\` (prebuffer 500 ms, underrun -> new talkspurt) are in on branch \`worktree-wa-say\`; \`_playWebrtc\` now runs through the pump with the full suite still green. Next: \`speak()\` (say.py -> ffmpeg -> packets)."
```

---

### Task 3: `speak()` — say.py -> ffmpeg -> Opus packets

**Files:**
- Create: `src/say.mjs`
- Create: `test/helpers/fake-say.mjs`
- Test: `test/say.test.mjs`

**Interfaces:**
- Consumes: `oggOpusPackets` from `src/ogg-stream.mjs`.
- Produces: `speak(text: string, opts): AsyncGenerator<{data: Buffer, samples: number}>` with `opts = { python: string, sayPath: string, voice?: string, backend?: string = "modal", signal?: AbortSignal, ffmpegPath?: string = "ffmpeg", killGraceMs?: number = 2000 }`. Throws (on first `next()` after the processes finish) if `say.py`/ffmpeg exits non-zero, fails to spawn, or no audio was produced. Aborting `signal` or calling `.return()` terminates both processes and resolves without throwing; it awaits their exit before finishing.

- [ ] **Step 1: Write the stand-in for say.py**

Create `test/helpers/fake-say.mjs` (used as `sayPath` with `python: process.execPath`):

```js
// Stand-in for huggingsesame's `say.py --pcm-out` so tests and offline demos
// need no cloud. Behaviour is chosen by environment variables:
//   FAKE_SAY_SECONDS=N        length of the 440 Hz tone (default 1)
//   FAKE_SAY_MODE=hang        emit nothing and wait to be killed (cold start)
//   FAKE_SAY_MODE=fail        write to stderr and exit 3 with no output
//   FAKE_SAY_STDIN_FILE=path  write the text received on stdin to this file
//   FAKE_SAY_PID_FILE=path    write this process's pid to this file
// Output is 24 kHz mono s16le on stdout, like the real thing.

import { writeFileSync } from "node:fs";

let text = "";
process.stdin.setEncoding("utf8");
for await (const c of process.stdin) text += c;

if (process.env.FAKE_SAY_PID_FILE) writeFileSync(process.env.FAKE_SAY_PID_FILE, String(process.pid));
if (process.env.FAKE_SAY_STDIN_FILE) writeFileSync(process.env.FAKE_SAY_STDIN_FILE, text);

const mode = process.env.FAKE_SAY_MODE;
if (mode === "fail") {
  console.error("[say] simulated failure: no token");
  process.exit(3);
}
if (mode === "hang") {
  setInterval(() => {}, 1000); // alive until SIGTERM
} else {
  const n = Math.round(24000 * Number(process.env.FAKE_SAY_SECONDS ?? 1));
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2);
  }
  for (let i = 0; i < pcm.length; i += 960) {
    if (!process.stdout.write(pcm.subarray(i, i + 960))) {
      await new Promise((r) => process.stdout.once("drain", r));
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/say.test.mjs`:

```js
// speak(): say.py (stubbed) -> ffmpeg Opus -> demuxed packets, and above all
// its teardown. Needs ffmpeg on PATH; skips itself if missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { speak } from "../src/say.mjs";

const hasFfmpeg = (() => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const FAKE = fileURLToPath(new URL("./helpers/fake-say.mjs", import.meta.url));
const base = { python: process.execPath, sayPath: FAKE };
const opts = { skip: !hasFfmpeg, timeout: 20000 };

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
}
const tmp = () => mkdtempSync(path.join(tmpdir(), "say-test-"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function collect(it) { const out = []; for await (const p of it) out.push(p); return out; }

test("1 s of tone becomes ~50 Opus packets of 960 samples", opts, async () => {
  const pk = await withEnv({ FAKE_SAY_SECONDS: "1" }, () => collect(speak("hello", base)));
  assert.ok(pk.length >= 48 && pk.length <= 53, `got ${pk.length} packets`);
  assert.ok(pk.every((p) => p.samples === 960));
});

test("text reaches say.py intact (quotes, $(), leading dash, newline, emoji)", opts, async () => {
  const dir = tmp();
  try {
    const nasty = `-rf "$(echo hi)" 'x'\nsecond line — émoji 🎙`;
    const file = path.join(dir, "stdin.txt");
    await withEnv({ FAKE_SAY_SECONDS: "0.2", FAKE_SAY_STDIN_FILE: file }, () => collect(speak(nasty, base)));
    assert.equal(readFileSync(file, "utf8"), nasty);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("say.py exiting non-zero surfaces its reason", opts, async () => {
  await withEnv({ FAKE_SAY_MODE: "fail" }, () =>
    assert.rejects(collect(speak("x", base)), /say\.py exited 3.*simulated failure/));
});

test("missing python or ffmpeg rejects with a spawn error and does not crash", opts, async () => {
  await assert.rejects(collect(speak("x", { ...base, python: "/nonexistent/python" })), /ENOENT/);
  await withEnv({ FAKE_SAY_SECONDS: "0.2" }, () =>
    assert.rejects(collect(speak("x", { ...base, ffmpegPath: "/nonexistent/ffmpeg" })), /ENOENT/));
});

test("abort during a cold start (no PCM yet) kills say.py and resolves quietly", opts, async () => {
  const dir = tmp();
  try {
    const pidFile = path.join(dir, "pid");
    const ac = new AbortController();
    const t0 = Date.now();
    const pk = await withEnv({ FAKE_SAY_MODE: "hang", FAKE_SAY_PID_FILE: pidFile }, async () => {
      setTimeout(() => ac.abort(), 300);
      return collect(speak("x", { ...base, signal: ac.signal }));
    });
    assert.deepEqual(pk, []);
    assert.ok(Date.now() - t0 < 5000, "returned promptly");
    assert.ok(existsSync(pidFile), "stub actually started");
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "say.py is gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("consumer stopping early (return()) tears everything down", opts, async () => {
  const dir = tmp();
  try {
    const pidFile = path.join(dir, "pid");
    const t0 = Date.now();
    await withEnv({ FAKE_SAY_SECONDS: "30", FAKE_SAY_PID_FILE: pidFile }, async () => {
      let n = 0;
      for await (const _ of speak("x", base)) if (++n === 3) break;
    });
    assert.ok(Date.now() - t0 < 5000, "did not wait for the 30 s clip");
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "say.py is gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/say.test.mjs`
Expected: FAIL, `Cannot find module '../src/say.mjs'`.

- [ ] **Step 4: Implement**

Create `src/say.mjs`:

```js
// Text -> a stream of Opus packets, for `wa say`.
//
//   say.py --pcm-out  --(24 kHz mono s16le)-->  ffmpeg libopus  --(Ogg)-->  oggOpusPackets
//
// All TTS work (sentence grouping, the cloud call, Mimi decode, QC) happens in
// huggingsesame's say.py; this module only runs it, encodes its PCM and
// guarantees both child processes are gone when the stream ends for any reason
// (finished, error, consumer stopped, signal aborted).

import { spawn } from "node:child_process";
import { oggOpusPackets } from "./ogg-stream.mjs";

// -page_duration 20000 is essential: without it ffmpeg buffers ~1 s of audio
// per Ogg page and the stream stutters out in one-second lumps.
const ffmpegArgs = [
  "-v", "error",
  "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
  "-c:a", "libopus", "-frame_duration", "20",
  "-page_duration", "20000", "-flush_packets", "1",
  "-f", "ogg", "pipe:1",
];

/**
 * @param {string} text
 * @param {{python:string, sayPath:string, voice?:string, backend?:string,
 *          signal?:AbortSignal, ffmpegPath?:string, killGraceMs?:number}} opts
 * @returns {AsyncGenerator<{data: Buffer, samples: number}>}
 */
export async function* speak(
  text,
  { python, sayPath, voice, backend = "modal", signal, ffmpegPath = "ffmpeg", killGraceMs = 2000 } = {}
) {
  if (!python || !sayPath) throw new Error("speak: python and sayPath are required");
  if (signal?.aborted) return;

  const children = [];
  let spawnError = null;
  let killTimer = null;
  const killAll = (sig) => {
    for (const { c } of children) {
      if (c.pid && c.exitCode === null && c.signalCode === null) c.kill(sig);
    }
  };
  const stopAll = () => {
    killAll("SIGTERM");
    killTimer ??= setTimeout(() => killAll("SIGKILL"), killGraceMs);
  };
  const start = (cmd, args) => {
    const c = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const rec = { c, tail: "", exited: null };
    rec.exited = new Promise((resolve) => {
      c.once("close", (code, sig) => resolve({ code, sig }));
      c.once("error", (e) => {
        spawnError ??= e;
        resolve({ code: -1, sig: null });
        stopAll();
      });
    });
    c.stdin.on("error", () => {}); // EPIPE when the other end died first
    c.stdout.on("error", () => {});
    c.stderr.on("data", (d) => { rec.tail = (rec.tail + d).slice(-2000); });
    children.push(rec);
    return rec;
  };

  // Text goes on stdin ("-"), so quotes, newlines, a leading dash and length
  // limits never touch a shell or argv.
  const sayArgs = [sayPath, "--pcm-out", "--quiet", "--backend", backend, ...(voice ? ["--voice", voice] : []), "-"];
  const say = start(python, sayArgs);
  const ff = start(ffmpegPath, ffmpegArgs);
  const onAbort = () => stopAll();
  signal?.addEventListener("abort", onAbort, { once: true });

  let yielded = 0;
  try {
    say.c.stdout.pipe(ff.c.stdin);
    say.c.stdin.end(text);
    for await (const pkt of oggOpusPackets(ff.c.stdout)) {
      yielded++;
      yield pkt;
    }
    const [s, f] = await Promise.all([say.exited, ff.exited]);
    if (signal?.aborted) return;
    if (spawnError) throw new Error(`speak: ${spawnError.message}`);
    const last = (rec) => rec.tail.trim().split("\n").pop();
    if (s.code !== 0) throw new Error(`say.py exited ${s.code ?? s.sig}${say.tail.trim() ? `: ${last(say)}` : ""}`);
    if (f.code !== 0) throw new Error(`ffmpeg exited ${f.code ?? f.sig}${ff.tail.trim() ? `: ${last(ff)}` : ""}`);
    if (!yielded) throw new Error("say.py produced no audio");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stopAll();
    await Promise.all(children.map((r) => r.exited));
    clearTimeout(killTimer);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/say.test.mjs`
Expected: 6 tests PASS (or all skipped, with a visible skip, if ffmpeg is missing; then install ffmpeg and rerun, since skipped is not passing).

- [ ] **Step 6: Commit**

```bash
git add src/say.mjs test/helpers/fake-say.mjs test/say.test.mjs
git commit -m "$(cat <<'EOF'
feat: speak() streams say.py PCM through ffmpeg to Opus packets, with full teardown (#7)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `WaAudio.say()` and `stopSay()`

**Files:**
- Modify: `src/wa-audio.mjs` (import, constructor option, new methods after `play`)
- Test: `test/wa-audio-say.test.mjs`

**Interfaces:**
- Consumes: `speak` (Task 3), `_pump`, `_connectedPeers`, `PUMP_PREBUFFER_PACKETS` (Task 2).
- Produces:
  - `new WaAudio(client, { iceServers?, listen?, tts?: { python: string, sayPath: string, backend?: string } })`
  - `WaAudio#say(text: string, { voice?: string, indicator?: boolean }): Promise<{ played: boolean, reason?: string, packetsSent?: number, writeErrors?: number, peers?: number, peerStates?: string[], firstAudioMs?: number|null, firstRtpMs?: number|null, transport?: "webrtc" }>` — never rejects. `firstAudioMs` = ms from the call to the first Opus packet from `say.py`; `firstRtpMs` = ms from the call to the first RTP written.
  - `WaAudio#stopSay(): boolean` — stops only a `say` in flight (not a `sound`); returns whether one was stopped.

- [ ] **Step 1: Write the failing test**

Create `test/wa-audio-say.test.mjs`:

```js
// WaAudio.say(): the whole chain with a stubbed say.py and a fake peer. Needs
// ffmpeg; skips itself if missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WaAudio } from "../src/wa-audio.mjs";

const hasFfmpeg = (() => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const FAKE = fileURLToPath(new URL("./helpers/fake-say.mjs", import.meta.url));
const opts = { skip: !hasFfmpeg, timeout: 30000 };

function fakeClient() {
  const c = new EventEmitter();
  c.micOn = true;
  c.spaces = new Map([["s1", { spaceUserId: "u1" }]]);
  c.sent = [];
  c._send = (m) => c.sent.push(m);
  c.query = async () => ({ iceServersAnswer: { iceServers: [] } });
  c.adapter = { micState: { speakingMaskPaths: ["showVoiceIndicator", "microphoneState"] } };
  return c;
}
function fakePeer() {
  const rtp = [];
  return {
    pc: { connectionState: "connected", close() {} },
    track: { writeRtp: (pkt) => rtp.push(pkt) },
    spaceName: "s1", remoteUserId: "peer-1", ssrc: 1, seq: 0, ts: 0,
    lastPlayEnd: performance.now(),
    _rtp: rtp,
  };
}
function setup() {
  const audio = new WaAudio(fakeClient(), { tts: { python: process.execPath, sayPath: FAKE } });
  const peer = fakePeer();
  audio.peers.set("p1", peer);
  return { audio, peer };
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
}
const speaking = (client) =>
  client.sent.filter((m) => m.updateSpaceUserMessage).map((m) => m.updateSpaceUserMessage.user.showVoiceIndicator);

test("say streams ~1 s of speech as RTP and reports timings", opts, async () => {
  const { audio, peer } = setup();
  const r = await withEnv({ FAKE_SAY_SECONDS: "1" }, () => audio.say("hello"));
  assert.equal(r.played, true);
  assert.equal(r.transport, "webrtc");
  assert.ok(peer._rtp.length >= 48 && peer._rtp.length <= 53, `rtp ${peer._rtp.length}`);
  assert.equal(peer._rtp[0].header.marker, true);
  assert.ok(r.firstAudioMs > 0 && r.firstRtpMs >= r.firstAudioMs, `${r.firstAudioMs} / ${r.firstRtpMs}`);
  assert.deepEqual(speaking(audio.client), [true, false]);
  assert.equal(audio._play, null);
});

test("a new say supersedes the one in flight", opts, async () => {
  const { audio } = setup();
  const first = withEnv({ FAKE_SAY_SECONDS: "5" }, () => audio.say("one"));
  await sleep(900); // past the 500 ms prebuffer, so the first is really playing
  const second = await withEnv({ FAKE_SAY_SECONDS: "0.5" }, () => audio.say("two"));
  const r1 = await first;
  assert.equal(r1.played, false);
  assert.equal(second.played, true);
  assert.equal(audio._play, null);
});

test("hangup mid-sentence stops speech promptly and releases the guard", opts, async () => {
  const { audio } = setup();
  const p = withEnv({ FAKE_SAY_SECONDS: "5" }, () => audio.say("long"));
  await sleep(900);
  const t0 = Date.now();
  audio.hangup("test");
  const r = await p;
  assert.equal(r.played, false);
  assert.ok(Date.now() - t0 < 3000, "stopped promptly");
  assert.equal(audio._play, null);
  assert.equal(speaking(audio.client).at(-1), false);
});

test("stopSay stops a say but not a clip, and reports which", opts, async () => {
  const { audio } = setup();
  assert.equal(audio.stopSay(), false, "nothing to stop");
  const p = withEnv({ FAKE_SAY_SECONDS: "5" }, () => audio.say("long"));
  await sleep(900);
  assert.equal(audio.stopSay(), true);
  assert.equal((await p).played, false);
  audio._play = { kind: "clip", stop() { throw new Error("must not be called"); } };
  assert.equal(audio.stopSay(), false, "a clip is left alone");
  audio._play = null;
});

test("no connected peers: returns the reason and never starts say.py", opts, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "say-audio-"));
  try {
    const pidFile = path.join(dir, "pid");
    const audio = new WaAudio(fakeClient(), { tts: { python: process.execPath, sayPath: FAKE } });
    const r = await withEnv({ FAKE_SAY_PID_FILE: pidFile }, () => audio.say("anyone?"));
    assert.equal(r.played, false);
    assert.equal(r.reason, "no connected peers");
    assert.equal(existsSync(pidFile), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("say.py failure resolves played:false with the reason and never lights the indicator", opts, async () => {
  const { audio } = setup();
  const r = await withEnv({ FAKE_SAY_MODE: "fail" }, () => audio.say("x"));
  assert.equal(r.played, false);
  assert.match(r.reason, /say\.py exited 3/);
  assert.deepEqual(speaking(audio.client), []);
  assert.equal(audio._play, null);
});

test("on a LiveKit-escalated meeting say reports it is not built yet (slice 1)", opts, async () => {
  const { audio } = setup();
  audio._livekit = {};
  const r = await audio.say("x");
  assert.equal(r.played, false);
  assert.match(r.reason, /livekit/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wa-audio-say.test.mjs`
Expected: FAIL, `audio.say is not a function`.

- [ ] **Step 3: Implement**

In `src/wa-audio.mjs`:

1. Add the import next to the other local imports: `import { speak } from "./say.mjs";`
2. Change the constructor signature to `constructor(client, { iceServers, listen = false, tts = {} } = {}) {` and, right after the `this._play = null; ...` line, add `this._tts = tts; // { python, sayPath, backend? } for say()`.
3. Insert after the `play()` method:

```js
  /**
   * Speak `text` to every connected WEBRTC peer: say.py streams PCM, ffmpeg
   * encodes it to Opus (src/say.mjs), and _pump paces it out as RTP with a
   * 500 ms prebuffer. Claims the same `_play` token as play(), so a new say (or
   * a sound) supersedes it and hangup() stops it. Resolves when speech ends or
   * is stopped; never rejects. LiveKit-escalated meetings are slice 1 of #7.
   */
  async say(text, { voice, indicator = true } = {}) {
    if (this._livekit) return { played: false, reason: "livekit say not implemented yet" };
    this._play?.stop();
    const ac = new AbortController();
    let stopped = false;
    const token = (this._play = {
      kind: "say",
      stop: () => {
        stopped = true;
        ac.abort();
      },
    });
    const t0 = performance.now();
    let firstAudioAt = null;
    try {
      if (!this._connectedPeers().length) return { played: false, reason: "no connected peers" };
      const source = speak(text, { ...this._tts, voice, signal: ac.signal });
      const packets = (async function* () {
        for await (const p of source) {
          firstAudioAt ??= performance.now();
          yield p;
        }
      })();
      const r = await this._pump(packets, {
        getTargets: () => this._connectedPeers(),
        isStopped: () => stopped,
        indicator,
        prebuffer: PUMP_PREBUFFER_PACKETS,
      });
      return {
        played: !stopped && r.packetsSent > 0,
        reason: r.reason,
        packetsSent: r.packetsSent,
        writeErrors: r.writeErrors,
        peers: r.peers,
        peerStates: r.peerStates,
        firstAudioMs: firstAudioAt == null ? null : Math.round(firstAudioAt - t0),
        firstRtpMs: r.firstSendAt == null ? null : Math.round(r.firstSendAt - t0),
        transport: "webrtc",
      };
    } catch (e) {
      return { played: false, reason: e.message };
    } finally {
      if (this._play === token) this._play = null;
    }
  }

  /** Stop a say in flight (not a sound/clip). @returns {boolean} whether one was stopped */
  stopSay() {
    if (this._play?.kind !== "say") return false;
    this._play.stop();
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/wa-audio-say.test.mjs && npm test`
Expected: 7 new tests PASS and the full suite stays green.

- [ ] **Step 5: Commit and report progress**

```bash
git add src/wa-audio.mjs test/wa-audio-say.test.mjs
git commit -m "$(cat <<'EOF'
feat: WaAudio.say() speaks over the WebRTC mesh, with stopSay() (#7)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
gh issue comment 7 --repo campey/workadventurer --body "Slice 2 progress: \`speak()\` (say.py -> ffmpeg Opus -> packets, full teardown) and \`WaAudio.say()\`/\`stopSay()\` are in with tests against a stubbed say.py: streaming, supersede, hang-up mid-sentence, failure surfaces cleanly, no peers means say.py never starts. Next: config keys, daemon \`/say\` + \`/say-cancel\`, \`wa say\`, then an offline run with a real browser peer."
```

---

### Task 5: Config keys, daemon endpoints, CLI, docs

**Files:**
- Modify: `src/config.mjs` (BASE, ENV_MAP, `configToEnv`)
- Modify: `src/wa-daemon.mjs` (header comment ~line 18, `attachAudio` ~line 62, new routes after `/sound`)
- Modify: `bin/wa.mjs` (USAGE, parseArgs options, `report` keys, new `say` case)
- Modify: `README.md` (CLI table ~line 69, HTTP table ~line 150, file table ~line 173), `docs/field-notes.md` (short "wa say" section)
- Test: `test/config-tts.test.mjs`

**Interfaces:**
- Consumes: `WaAudio#say`, `#stopSay`, `#waitForLiveKit`, `#connected`.
- Produces: config fields `ttsPython`, `ttsSay`; `POST /say {text, voice?}` -> 202 `{ok, say, speaking:true}` | 400 | 409 | 501 | 503; `POST /say-cancel {}` -> 200 `{ok, cancelled: boolean}`; CLI `wa say <text…> [--voice id]` and `wa say --cancel`.

- [ ] **Step 1: Write the failing test**

Create `test/config-tts.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, configToEnv } from "../src/config.mjs";

test("WA_TTS_PYTHON / WA_TTS_SAY resolve into config and travel to a spawned daemon", () => {
  const saved = { p: process.env.WA_TTS_PYTHON, s: process.env.WA_TTS_SAY };
  process.env.WA_TTS_PYTHON = "/opt/py/bin/python3";
  process.env.WA_TTS_SAY = "/opt/hs/src/say.py";
  try {
    const cfg = resolveConfig();
    assert.equal(cfg.ttsPython, "/opt/py/bin/python3");
    assert.equal(cfg.ttsSay, "/opt/hs/src/say.py");
    const env = configToEnv(cfg);
    assert.equal(env.WA_TTS_PYTHON, "/opt/py/bin/python3");
    assert.equal(env.WA_TTS_SAY, "/opt/hs/src/say.py");
  } finally {
    saved.p === undefined ? delete process.env.WA_TTS_PYTHON : (process.env.WA_TTS_PYTHON = saved.p);
    saved.s === undefined ? delete process.env.WA_TTS_SAY : (process.env.WA_TTS_SAY = saved.s);
  }
});

test("defaults are python3 and huggingsesame's say.py", () => {
  const cfg = resolveConfig();
  assert.ok(cfg.ttsPython);
  assert.ok(cfg.ttsSay.endsWith("say.py"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config-tts.test.mjs`
Expected: FAIL, `cfg.ttsPython` is `undefined`.

- [ ] **Step 3: Implement config**

In `src/config.mjs`:
- In `BASE` add after `stt: false, ...`:
  ```js
  ttsPython: "python3", // WA_TTS_PYTHON -> interpreter for huggingsesame's say.py (issue #7)
  ttsSay: path.join(os.homedir(), "Code", "huggingsesame", "src", "say.py"), // WA_TTS_SAY
  ```
- In `ENV_MAP` add `WA_TTS_PYTHON: "ttsPython",` and `WA_TTS_SAY: "ttsSay",`.
- In `configToEnv` add `WA_TTS_PYTHON: cfg.ttsPython,` and `WA_TTS_SAY: cfg.ttsSay,` to the returned object.

Run: `node --test test/config-tts.test.mjs`
Expected: PASS.

- [ ] **Step 4: Daemon endpoints**

In `src/wa-daemon.mjs`:
- Header comment: add under the `POST /sound` line: `//   POST /say            {text, voice?}  -> speak text aloud to the bubble (TTS, issue #7)` and `//   POST /say-cancel     {}              -> stop a say in progress`.
- In `attachAudio`, change the constructor call to:
  ```js
  audio = new WaAudio(client, {
    listen: cfg.stt,
    tts: { python: cfg.ttsPython, sayPath: cfg.ttsSay },
  });
  ```
- After the `/sound` case's closing brace, add:
  ```js
        case "/say": {
          const text = String(body.text ?? "").trim();
          if (!text) return send(400, { ok: false, error: "need {text}" });
          if (!audio) return send(503, { ok: false, error: "audio not ready" });
          await audio.waitForLiveKit();
          if (audio._livekit)
            return send(501, { ok: false, error: "say over LiveKit isn't built yet (issue #7, slice 1)" });
          if (!audio.connected)
            return send(409, { ok: false, error: "no one in the bubble to hear it" });
          // Fire and forget: speech runs for as long as the utterance (and the
          // cloud's cold start can add minutes before the first sound).
          audio
            .say(text, { voice: body.voice ? String(body.voice) : undefined })
            .then((r) =>
              log(
                `say (${text.length} chars): ` +
                  (r.played ? "done" : `NOT played (${r.reason ?? "?"})`) +
                  ` — first audio ${r.firstAudioMs ?? "?"} ms, first RTP ${r.firstRtpMs ?? "?"} ms,` +
                  ` ${r.packetsSent ?? 0} pkts to ${r.peers ?? 0} peer(s)` +
                  (r.writeErrors ? `, ${r.writeErrors} write errors` : "")
              )
            )
            .catch((e) => log(`say failed: ${e.message}`));
          return send(202, { ok: true, say: text, speaking: true });
        }
        case "/say-cancel": {
          const cancelled = audio ? audio.stopSay() : false;
          return send(200, { ok: true, cancelled });
        }
  ```

- [ ] **Step 5: CLI**

In `bin/wa.mjs`:
- USAGE, after the `wa sound` line: `  wa say <text…> [--voice <id>]  speak text aloud to the bubble (TTS)\n  wa say --cancel             stop speaking`
- `parseArgs` options: add `voice: { type: "string" },` and `cancel: { type: "boolean", default: false },`.
- `report()` key list: add `"say"` and `"cancelled"` (after `"sound"`).
- New case after `case "sound": {...}`:
  ```js
  case "say": {
    if (flags.cancel) {
      await needDaemon();
      const r = await api("POST", "/say-cancel", {});
      if (!r.ok) die(r.json.error || `say --cancel failed (${r.status})`);
      report(r.json);
      break;
    }
    const text = args.join(" ").trim();
    if (!text) die("usage: wa say <text…> [--voice <id>]   |   wa say --cancel", 2);
    await needDaemon();
    const r = await api("POST", "/say", { text, voice: flags.voice });
    if (!r.ok) die(r.json.error || `say failed (${r.status})`);
    report(r.json);
    break;
  }
  ```

- [ ] **Step 6: Smoke the wiring without a room**

Run: `node bin/wa.mjs say 2>&1 | head -3; node bin/wa.mjs --help | grep -n "say"`
Expected: the usage line `usage: wa say <text…> [--voice <id>]   |   wa say --cancel`, and two `say` lines in the help.

- [ ] **Step 7: Docs**

- `README.md`: add a CLI-table row `| \`wa say <text…> [--voice id]\` | speak text aloud to the bubble via huggingsesame TTS (WEBRTC bubbles; needs \`WA_TTS_PYTHON\`/\`WA_TTS_SAY\`) |` after the `wa sound` row (~line 69); add `| \`POST /say\` \`{text, voice?}\` / \`POST /say-cancel\` | speak / stop speaking |` after the `/sound` row (~line 150); add file rows `| \`src/say.mjs\` | \`wa say\`: runs huggingsesame's \`say.py\`, encodes PCM to Opus, tears down the processes |` and `| \`src/ogg-stream.mjs\` | incremental Ogg/Opus demuxer for streamed audio |` near `src/transcode.mjs` (~line 173).
- `docs/field-notes.md`: append a "## `wa say` (issue #7)" section (3-6 lines) recording: the interface (`say.py --pcm-out`), that `-page_duration 20000` is what keeps latency at one frame, the 500 ms prebuffer / underrun talkspurt behaviour, and that LiveKit say is not built yet. Add measured numbers in Task 6/7 once known.

- [ ] **Step 8: Full suite and commit**

Run: `npm test`
Expected: all green.

```bash
git add src/config.mjs src/wa-daemon.mjs bin/wa.mjs README.md docs/field-notes.md test/config-tts.test.mjs
git commit -m "$(cat <<'EOF'
feat: wa say, POST /say and /say-cancel, WA_TTS_* config (#7)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Offline end-to-end on the WEBRTC mesh (needs a real browser peer)

Two headless werift peers cannot complete ICE on one host (see the header of `test/wa-audio-prime.test.mjs`), so a human in a browser is the listener. No cloud: `say.py` is the stub.

**Files:** none (verification); results go to a comment on #7 and `docs/field-notes.md`.

- [ ] **Step 1: Pick a free port and start the avatar**

```bash
lsof -iTCP -sTCP:LISTEN -P | grep node        # note which ports are taken (6767 and 8787 are not ours)
export WA_DAEMON_PORT=8791                    # any free port other than 8787
export WA_TTS_PYTHON="$(command -v node)"
export WA_TTS_SAY="$PWD/test/helpers/fake-say.mjs"
export FAKE_SAY_SECONDS=8
node bin/wa.mjs join --detach --name wa-say --port 8791
node bin/wa.mjs status --port 8791
```
Expected: `wa status` shows the avatar `wa-say` in the room. (The stub inherits `FAKE_SAY_SECONDS` through the daemon's environment.)

- [ ] **Step 2: Ask the user to join a bubble with `wa-say` in a browser, with sound on, then say**

```bash
node bin/wa.mjs say --port 8791 "offline end to end"
```
Expected: the user hears an 8 s 440 Hz tone; the daemon log `~/.workadventurer/daemon-8791.log` ends with `say (18 chars): done — first audio … ms, first RTP … ms, … pkts to 1 peer(s)` (expect ~400 packets, first RTP ≈ first audio + ~500 ms). The speaking ring lights during the tone and clears after.

- [ ] **Step 3: Interrupt, supersede, status responsiveness**

```bash
node bin/wa.mjs say --port 8791 "first"; sleep 2; node bin/wa.mjs say --port 8791 "second"   # tone restarts, only one tone at a time
node bin/wa.mjs say --port 8791 "cancel me"; sleep 2; time node bin/wa.mjs status --port 8791; node bin/wa.mjs say --cancel --port 8791
```
Expected: supersede restarts the tone; `wa status` returns in well under a second while speaking; `say --cancel` prints `cancelled: true` and the tone stops; calling it again prints `ok` (nothing cancelled).

- [ ] **Step 4: Hang-up mid-sentence and orphan check**

```bash
node bin/wa.mjs say --port 8791 "hang up on me"; sleep 2; node bin/wa.mjs leave --port 8791
sleep 3; pgrep -fl "fake-say|libopus" || echo "no orphans"
```
Expected: `no orphans`. Repeat once with the user walking out of the bubble mid-sentence instead of `wa leave`.

- [ ] **Step 5: Regression: `wa sound` still works**

Rejoin (`wa join --detach --name wa-say --port 8791`), have the user rejoin the bubble, run `node bin/wa.mjs sound chime --port 8791`. Expected: the chime plays as before. Then `node bin/wa.mjs leave --port 8791`; confirm `lsof -iTCP -sTCP:LISTEN -P | grep 8791` is empty.

- [ ] **Step 6: Record and report**

Add the measured numbers (first audio, first RTP, packets, status latency) to the `wa say` section of `docs/field-notes.md`, commit (`docs: wa say offline end-to-end results (#7)` with the trailer), and post them as a comment on #7 (`gh issue comment 7 --repo campey/workadventurer --body "..."`).

---

### Task 7: Live cloud demo, PR

Costs money and needs the user: a warm container is ~$1/hr. Do not start this task without the user's go-ahead.

- [ ] **Step 1: Ask the user to go; check cloud state**

Run: `python3 /Users/campey/Code/huggingsesame/src/modal_ctl.py status`
Expected: prints the service state. If cold, warn the user the first audio takes 1 to 2.5 minutes.

- [ ] **Step 2: Handshake before real content**

Run: `python3 /Users/campey/Code/huggingsesame/src/say.py --hello`
Expected: speaks one line and exits 0. **Wait for the user to confirm they heard it.** Exit 0 only means data flowed.

- [ ] **Step 3: Live say through the avatar**

Unset the stub (`unset WA_TTS_PYTHON WA_TTS_SAY FAKE_SAY_SECONDS`), start the avatar on the Task 6 port, get the user into the bubble, then:

```bash
node bin/wa.mjs say --port 8791 "Hey, I'm Claude and I can now chat to you here."
```
Expected: the user hears it. From the daemon log note time-to-first-audio (cold vs warm), and judge sustained rate: any audible gaps, and whether the log shows underruns (new talkspurts). Then a longer paragraph (3 to 4 sentences, plain periods, no em-dashes), an interrupt with a second `wa say`, `wa say --cancel`, and a hang-up mid-sentence followed by `pgrep -fl "say.py|mimi_sidecar|ffmpeg"` (nothing of ours left; unrelated ffmpeg processes may exist).

- [ ] **Step 4: Cool the cloud and clean up**

Run: `python3 /Users/campey/Code/huggingsesame/src/modal_ctl.py cool; node bin/wa.mjs leave --port 8791`
Expected: container cooling; no avatar or daemon left on the test port.

- [ ] **Step 5: Record, push, open the PR**

Add live numbers to `docs/field-notes.md`, commit, then:

```bash
git push -u origin worktree-wa-say
gh pr create --repo campey/workadventurer --title "wa say: speech over the WebRTC mesh (#7, slice 2)" --body "$(cat <<'EOF'
## Summary
- `wa say <text>` / `POST /say` / `POST /say-cancel`: huggingsesame `say.py --pcm-out` -> ffmpeg libopus -> incremental Ogg demuxer -> RTP on the WEBRTC mesh path
- `WaAudio._pump` extracted from `_playWebrtc` (prebuffer 500 ms, underrun starts a new talkspurt); `wa sound` unchanged
- `speak()` guarantees say.py and ffmpeg are gone on finish, error, supersede and hang-up
- LiveKit transport is slice 1 and not in this PR (`/say` returns 501 there)

Spec: `docs/superpowers/specs/2026-10-13-wa-say-webrtc-design.md`. Plan: `docs/superpowers/plans/2026-10-13-wa-say-webrtc.md`.

## Test plan
- [x] `npm test` (new: ogg-stream, wa-audio-pump, say, wa-audio-say, config-tts)
- [x] Offline end-to-end with a stub say.py and a real browser peer (numbers in docs/field-notes.md)
- [x] Live cloud demo, handshake confirmed first (numbers in docs/field-notes.md)

Refs #7

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then comment the PR link and measured numbers on #7. Do not merge until the user says to; when they do, merge with `gh pr merge --merge` (never squash). Slice 1 (LiveKit) remains, so #7 stays open and In Progress.
