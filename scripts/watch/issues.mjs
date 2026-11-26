// Adapter watcher, step 5-6: the GitHub issue policy (#127).
//
//   production: one issue per hash, found by label `adapter-watch` plus "(adapter <hash>)" in the
//               title ("Server v1.34.5 needs attention (adapter abcdef01)"); created or updated on a
//               failure, closed with a comment by a later pass. Never a new issue per run.
//   staging:    ONE open issue, "Staging needs attention", updated to name the newest failing hash,
//               closed when a staging hash passes. A seenOn failure (an ok hash failing its gate on the OTHER
//               server) reports exactly like any other failure on that server.
//
// If several open issues match, the oldest is updated and the extras are reported (never closed
// or duplicated). Titles and bodies are built only from validated values: the hash (HASH_RE), the
// display version (^[\w.@-]{1,40}$), the gate text (gateDetail, in a code fence with backticks and
// @ neutralised) and a run URL of the form https://github.com/<repo>/actions/runs/<digits>.
// Nothing here throws: results are { ok, stage, ... } with stage in validate | find | create | update | close | unexpected.
//
// Adoption: an existing issue is only updated or closed if its body carries the hidden marker
// `<!-- adapter-watch:<hash|staging> -->` the watcher wrote AND it either carries the `adapter-watch` label
// (only people with triage rights can add it) or was authored by the Actions bot (BOT_LOGIN). The marker alone
// is not enough: anyone can paste it into a lookalike issue, and the watcher must never edit or close that.
// Both targets fall back to an unlabelled open search (production: title `Server ... (adapter <hash>)`;
// staging: title "Staging needs attention"; plus the marker and the author/label rule) so a removed label does
// not make the next run open a duplicate.
// Mentions: `@` never appears outside a code span except in the display form master@<hex>, and even
// that is rendered in a code span; any other `@` is rewritten to "(at)".

import { HASH_RE } from "../../src/catalog/schema.mjs";
import { gateDetail } from "../../src/catalog/recover.mjs";

export const LABEL = "adapter-watch";
export const STAGING_TITLE = "Staging needs attention";
const VERSION_RE = /^[\w.@-]{1,40}$/;
const SERVERS = ["production", "staging"];
/** The login the Actions token's issues carry (GET /issues returns user.login). */
export const BOT_LOGIN = "github-actions[bot]";

const msg = (e) => String(e?.message ?? e).slice(0, 300);
const fail = (stage, error, extra = {}) => ({ ok: false, stage, error, ...extra });

const productionTitle = (hash, version) => `Server${version ? ` ${safeToken(version)}` : ""} needs attention (adapter ${hash})`;
const titleOk = (hash) => (t) => t.startsWith("Server") && t.endsWith(`(adapter ${hash})`);
const markerFor = (server, hash) => `<!-- adapter-watch:${server === "staging" ? "staging" : hash} -->`;

/** A validated token made safe for prose: only the display form master@<hex> keeps its @. */
function safeToken(v) {
  return /^master@[0-9a-f]{7,40}$/.test(v) ? v : String(v).replace(/@/g, "(at)");
}
const code = (v) => `\`${safeToken(v)}\``;

/** Validate the inputs shared by both entry points. Returns { error } or the clean values. */
function check({ port, server, hash, version, runUrl }) {
  if (!SERVERS.includes(server)) return { error: `server must be one of ${SERVERS.join(", ")}` };
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return { error: "invalid adapter hash" };
  if (version != null && !(typeof version === "string" && VERSION_RE.test(version))) return { error: "version has unexpected characters or is too long" };
  if (runUrl != null) {
    const repo = port?.repo;
    if (typeof runUrl !== "string" || typeof repo !== "string" || runUrl !== `https://github.com/${repo}/actions/runs/${(runUrl.match(/\/runs\/(\d+)$/) ?? [])[1]}`) {
      return { error: "runUrl must be https://github.com/<repo>/actions/runs/<digits> for this repo" };
    }
  }
  return { version: version ?? null, runUrl: runUrl ?? null };
}

/** Gate text safe to show: control chars gone (gateDetail), no backticks (cannot close the fence), no @mentions. */
function safeGate(gate) {
  const g = gateDetail(gate);
  if (!g) return null;
  return g.replace(/`/g, "'").replace(/@/g, "(at)");
}

function candidateLine(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const parts = [];
  for (const k of ["waVersion", "protoFamily"]) {
    const v = candidate[k];
    if (typeof v === "string" && VERSION_RE.test(v)) parts.push(`${k} ${code(v)}`);
  }
  return parts.length ? parts.join(", ") : null;
}

function failureBody({ server, hash, version, runUrl, gate, candidate }) {
  const lines = [
    `The adapter watcher's gate failed for ${server} adapter hash \`${hash}\`${version ? ` (${code(version)})` : ""}.`,
    "",
    "What failed:",
    "```text",
    safeGate(gate) ?? "(no detail recorded)",
    "```",
  ];
  const cand = candidateLine(candidate);
  if (cand) lines.push("", `Candidate adapter: ${cand}`);
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  lines.push("", "This issue is updated by later runs and closed by the watcher when the gate passes.", "", markerFor(server, hash));
  return lines.join("\n");
}

/** Open issues this watcher owns for the target, oldest first: { matches, truncated }. */
async function findOwned(port, server, hash) {
  const marker = markerFor(server, hash);
  // Marker AND (the label OR the bot as author). Results of the labelled search carry the label by construction.
  const mine = (labelled) => (i) => typeof i.body === "string" && i.body.includes(marker)
    && (labelled || (Array.isArray(i.labels) && i.labels.includes(LABEL)) || i.author === BOT_LOGIN);
  const shape = server === "staging" ? (t) => t === STAGING_TITLE : titleOk(hash);
  const pick = (r, labelled) => ({ matches: r.issues.filter((i) => shape(i.title) && mine(labelled)(i)).sort((a, b) => a.number - b.number), truncated: !!r.truncated });
  let r = pick(await port.findIssues({ label: LABEL, state: "open" }), true);
  if (r.matches.length === 0) {
    const wide = pick(await port.findIssues({ state: "open" }), false);
    r = { matches: wide.matches, truncated: r.truncated || wide.truncated };
  }
  return r;
}

const flags = (truncated) => (truncated ? { truncated: true } : {});

/** Record a failed gate: create or update the one issue for this hash (production) or for staging. */
export async function reportFailure({ port, server, hash, version, gate, runUrl, candidate } = {}) {
  try {
    const c = check({ port, server, hash, version, runUrl });
    if (c.error) return fail("validate", c.error);
    const title = server === "staging" ? STAGING_TITLE : productionTitle(hash, c.version);
    const body = failureBody({ server, hash, version: c.version, runUrl: c.runUrl, gate, candidate });
    let found;
    try {
      found = await findOwned(port, server, hash);
    } catch (e) { return fail("find", msg(e)); }
    const open = found.matches;
    if (open.length === 0) {
      let made;
      try {
        made = await port.createIssue({ title, body, labels: [LABEL] });
      } catch (e) { return fail("create", msg(e)); }
      // A silently dropped label would make every later run miss the issue: check, retry once, else flag it.
      let labelMissing = false;
      if (!(made.labels ?? []).includes(LABEL)) {
        try {
          const l = await port.addLabels(made.number, [LABEL]);
          labelMissing = !(l?.labels ?? []).includes(LABEL);
        } catch { labelMissing = true; }
      }
      return { ok: true, action: "created", issue: made.number, extras: [], ...(labelMissing ? { labelMissing: true } : {}), ...flags(found.truncated) };
    }
    const [first, ...rest] = open;
    try {
      await port.updateIssue(first.number, { title, body });
    } catch (e) { return fail("update", msg(e)); }
    return { ok: true, action: "updated", issue: first.number, extras: rest.map((i) => i.number), ...flags(found.truncated) };
  } catch (e) {
    return fail("unexpected", msg(e));
  }
}

/**
 * Record a pass: close the open issue(s) for this hash (production), or the staging issue (staging),
 * each with a comment. Closing is the one place several open matches are all closed.
 */
export async function reportPass({ port, server, hash, version, runUrl } = {}) {
  try {
    const c = check({ port, server, hash, version, runUrl });
    if (c.error) return fail("validate", c.error);
    let found;
    try {
      found = await findOwned(port, server, hash);
    } catch (e) { return fail("find", msg(e)); }
    const comment = [`The gate passed for ${server} adapter hash \`${hash}\`${c.version ? ` (${code(c.version)})` : ""}; the adapter is published.`, c.runUrl ? `Run: ${c.runUrl}` : null].filter(Boolean).join("\n\n");
    const closed = [];
    for (const i of found.matches) {
      try {
        await port.closeIssue(i.number, { comment });
        closed.push(i.number);
      } catch (e) { return fail("close", msg(e), { closed }); }
    }
    return { ok: true, closed, ...flags(found.truncated) };
  } catch (e) {
    return fail("unexpected", msg(e));
  }
}
