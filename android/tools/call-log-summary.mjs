#!/usr/bin/env node
// Summarises the per-call debug logs the Android app writes (app "Share logs", or `adb shell run-as app.workadventurer cat
// files/logs/<file>`): how long, did it drop, how fast did audio start per peer, and the red-mic check (the phone told the
// server "mic on" but sent no audio). Usage: node android/tools/call-log-summary.mjs <log file>...
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const LINE = /^(\d\d):(\d\d):(\d\d)\.(\d{3}) (\S+) (.*)$/;
const STATS = /^\[([0-9a-f-]+)\] audio sent=(\d+) recv=(\d+) .*?dir=(\S*) mic=(on|off)/;
const STALL_SAMPLES = 2; // sample intervals (5 s each) with no new packets while the mic is on
const RED_MIC_AFTER_MS = 10_000; // mic announced on, still nothing sent this long afterwards

const clock = (ms) => {
  const t = ((ms % 86_400_000) + 86_400_000) % 86_400_000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(t / 3_600_000))}:${p(Math.floor(t / 60_000) % 60)}:${p(Math.floor(t / 1000) % 60)}.${p(t % 1000, 3)}`;
};

export function summarize(text) {
  const s = {
    app: "", phone: "", room: "", server: "", permissions: "",
    durationMs: 0, connectMs: null, drops: [], reconnects: 0, spaces: { joined: 0, left: 0 },
    peers: [], redMicSuspects: [], mutes: {}, deviceEvents: [], errors: [],
  };
  const peers = new Map();
  const announcements = []; // each time the phone told a space "mic on" after being off: { ms, at }
  let micAnnouncedOn = false;
  let day = 0, prev = -1, first = null, last = null, connectingAt = null;

  const peer = (id) => {
    if (!peers.has(id)) peers.set(id, { conn: id, initiator: null, startMs: null, audioLinesInOffers: [], offerLog: [], reOffers: 0, firstRecvAt: null, firstSentAt: null, timeToFirstRecvMs: null, samples: [], stalls: [] });
    return peers.get(id);
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) {
      const h = line.slice(2);
      if (h.startsWith("WorkAdventurer")) s.app = h;
      else if (h.startsWith("phone ")) s.phone = h.slice(6);
      else if (h.startsWith("room ")) s.room = h.slice(5);
      else if (h.startsWith("server ")) s.server = h.slice(7);
      continue;
    }
    const m = LINE.exec(line);
    if (!m) continue;
    let ms = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
    if (prev >= 0 && ms + day * 86_400_000 < prev) day++; // the clock passed midnight
    ms += day * 86_400_000;
    prev = ms;
    const at = clock(ms), tag = m[5], msg = m[6];
    if (first === null) first = ms;
    last = ms;

    if (tag === "WaSession") {
      if (msg === "connecting") connectingAt = ms;
      else if (msg === "connected" && s.connectMs === null && connectingAt !== null) s.connectMs = ms - connectingAt;
      else if (/^reconnecting \(attempt/.test(msg)) s.reconnects++;
      if (/connection dropped|connection attempt failed|join failed/.test(msg)) s.drops.push({ at, text: msg });
      const mute = /^mic (?:muted|unmuted) \((\w+)\)/.exec(msg);
      if (mute) s.mutes[mute[1]] = (s.mutes[mute[1]] ?? 0) + 1;
    } else if (tag === "WaDevice") {
      if (msg.startsWith("permissions:")) s.permissions = msg.slice(12).trim();
      else s.deviceEvents.push({ at, text: msg });
    } else if (tag === "WaConn") {
      let w;
      if ((w = /^webRtcStart conn=([0-9a-f-]+) initiator=(true|false)/.exec(msg))) {
        const p = peer(w[1]); p.initiator = w[2] === "true"; p.startMs = ms; p.startAt = at;
      } else if (/^joined space /.test(msg)) s.spaces.joined++;
      else if (/^left space /.test(msg)) s.spaces.left++;
      else if (/^mic on: announcing to [1-9]/.test(msg)) {
        if (!micAnnouncedOn) announcements.push({ ms, at });
        micAnnouncedOn = true;
      } else if (/^mic off:/.test(msg)) micAnnouncedOn = false;
    } else if (tag === "WaVoice") {
      let w;
      if ((w = /^\[([0-9a-f-]+)\] audio lines in offer: (\d+)( \(re-offer\))?/.exec(msg))) {
        const p = peer(w[1]); p.audioLinesInOffers.push(+w[2]); p.offerLog.push({ ms, n: +w[2] });
        if (w[3]) p.reOffers++;
      } else if ((w = /^\[([0-9a-f-]+)\] re-offered/.exec(msg))) peer(w[1]).reOffers++;
      else if ((w = STATS.exec(msg))) {
        const p = peer(w[1]);
        const sample = { ms, at, sent: +w[2], recv: +w[3], dir: w[4], mic: w[5] };
        p.samples.push(sample);
        if (p.firstRecvAt === null && sample.recv > 0) { p.firstRecvAt = at; if (p.startMs !== null) p.timeToFirstRecvMs = ms - p.startMs; }
        if (p.firstSentAt === null && sample.sent > 0) p.firstSentAt = at;
      }
    }
    if (msg.startsWith("ERROR ")) s.errors.push({ at, text: msg.slice(6) });
  }

  s.durationMs = first === null ? 0 : last - first;

  for (const p of peers.values()) {
    p.stalls = stalls(p.samples);
    for (const a of announcements) {
      if (p.startMs === null || p.startMs > a.ms) continue;
      const baseline = [...p.samples].reverse().find((x) => x.ms <= a.ms)?.sent ?? 0;
      const resumed = p.samples.find((x) => x.ms > a.ms && x.sent > baseline);
      const waited = (resumed ? resumed.ms : last) - a.ms;
      if (waited < RED_MIC_AFTER_MS) continue;
      const lines = [...p.offerLog].reverse().find((o) => o.ms <= a.ms);
      s.redMicSuspects.push({ conn: p.conn, fromAt: a.at, toAt: resumed ? resumed.at : null, waitedMs: waited, noAudioLine: lines ? lines.n === 0 : false });
    }
    delete p.offerLog;
    delete p.startMs;
    s.peers.push(p);
  }
  return s;
}

// Sending that stops while the mic is on. Runs from the last sample that still gained packets to the next one that does.
function stalls(samples) {
  const out = [];
  let i = 1;
  while (i < samples.length) {
    const a = samples[i - 1], b = samples[i];
    if (a.mic === "on" && b.mic === "on" && b.sent === a.sent && a.sent > 0) {
      let j = i;
      while (j < samples.length && samples[j].mic === "on" && samples[j].sent === a.sent) j++;
      if (j - i >= STALL_SAMPLES) out.push({ fromAt: a.at, toAt: j < samples.length ? samples[j].at : samples[j - 1].at, resumed: j < samples.length });
      i = j;
    } else i++;
  }
  return out;
}

const secs = (ms) => (ms === null || ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

export function format(s) {
  const out = [];
  out.push(`${s.app || "call log"}${s.phone ? ` on ${s.phone}` : ""}`);
  out.push(`room ${s.room || "?"} (${s.server || "?"})${s.permissions ? `, permissions: ${s.permissions}` : ""}`);
  out.push(`length ${secs(s.durationMs)}, connected after ${secs(s.connectMs)}, ${s.reconnects} reconnect(s), spaces joined/left ${s.spaces.joined}/${s.spaces.left}`);
  for (const d of s.drops) out.push(`  DROP ${d.at} ${d.text}`);
  for (const p of s.peers) {
    out.push(`peer ${p.conn.slice(0, 8)}: we ${p.initiator === null ? "?" : p.initiator ? "offered" : "answered"}, audio lines in offers [${p.audioLinesInOffers.join(", ")}], ` +
      `${p.reOffers} re-offer(s), first heard ${p.firstRecvAt ?? "never"} (${secs(p.timeToFirstRecvMs)} after start), first sent ${p.firstSentAt ?? "never"}`);
    for (const x of p.stalls) out.push(`  STALL mic on but nothing sent ${x.fromAt} -> ${x.toAt}${x.resumed ? "" : " (never resumed)"}`);
  }
  for (const r of s.redMicSuspects) {
    out.push(`  RED MIC? peer ${r.conn.slice(0, 8)}: told the server mic on at ${r.fromAt}, first audio sent ${r.toAt ?? "never"} (${secs(r.waitedMs)})` +
      (r.noAudioLine ? "; the last offer then had NO audio line to send on (issue #97)" : ""));
  }
  const mutes = Object.entries(s.mutes).map(([k, v]) => `${k} ${v}`).join(", ");
  if (mutes) out.push(`mute/unmute taps: ${mutes}`);
  for (const d of s.deviceEvents) out.push(`  device ${d.at} ${d.text}`);
  for (const e of s.errors) out.push(`  ERROR ${e.at} ${e.text}`);
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (files.length === 0) { console.error("usage: node android/tools/call-log-summary.mjs <call log file>..."); process.exit(2); }
  for (const f of files) console.log(`== ${f}\n${format(summarize(fs.readFileSync(f, "utf8")))}\n`);
}
