// Adapter watcher, step 5-6: the GitHub issue policy (#127).
//
//   production: one issue per hash, found by label `adapter-watch` plus "(adapter <hash>)" in the
//               title ("Server v1.34.5 needs attention (adapter abcdef01)"); created or updated on a
//               failure, closed with a comment by a later pass. Never a new issue per run.
//   staging:    ONE open issue, "Staging needs attention", updated to name the newest failing hash,
//               closed when a staging hash passes.
//
// If several open issues match, the oldest is updated and the extras are reported (never closed
// or duplicated). Titles and bodies are built only from validated values: the hash (HASH_RE), the
// display version (^[\w.@-]{1,40}$), the gate text (gateDetail, in a code fence with backticks and
// @ neutralised) and a run URL of the form https://github.com/<repo>/actions/runs/<digits>.
// Nothing here throws: results are { ok, stage, ... } with stage in validate | find | create | update | close.

import { HASH_RE } from "../../src/catalog/schema.mjs";
import { gateDetail } from "../../src/catalog/recover.mjs";

export const LABEL = "adapter-watch";
export const STAGING_TITLE = "Staging needs attention";
const VERSION_RE = /^[\w.@-]{1,40}$/;
const SERVERS = ["production", "staging"];

const msg = (e) => String(e?.message ?? e).slice(0, 300);
const fail = (stage, error, extra = {}) => ({ ok: false, stage, error, ...extra });

const productionTitle = (hash, version) => `Server${version ? ` ${version}` : ""} needs attention (adapter ${hash})`;
const hashMarker = (hash) => `(adapter ${hash})`;

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
    if (typeof v === "string" && VERSION_RE.test(v)) parts.push(`${k} ${v}`);
  }
  return parts.length ? parts.join(", ") : null;
}

function failureBody({ server, hash, version, runUrl, gate, candidate }) {
  const lines = [
    `The adapter watcher's gate failed for ${server} adapter hash \`${hash}\`${version ? ` (${version})` : ""}.`,
    "",
    "What failed:",
    "```text",
    safeGate(gate) ?? "(no detail recorded)",
    "```",
  ];
  const cand = candidateLine(candidate);
  if (cand) lines.push("", `Candidate adapter: ${cand}`);
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  lines.push("", "This issue is updated by later runs and closed by the watcher when the gate passes.");
  return lines.join("\n");
}

async function openMatching(port, test) {
  const found = await port.findIssues({ label: LABEL, state: "open" });
  return found.filter(test).sort((a, b) => a.number - b.number);
}

/** Record a failed gate: create or update the one issue for this hash (production) or for staging. */
export async function reportFailure({ port, server, hash, version, gate, runUrl, candidate } = {}) {
  try {
    const c = check({ port, server, hash, version, runUrl });
    if (c.error) return fail("validate", c.error);
    const title = server === "staging" ? STAGING_TITLE : productionTitle(hash, c.version);
    const body = failureBody({ server, hash, version: c.version, runUrl: c.runUrl, gate, candidate });
    let open;
    try {
      open = await openMatching(port, server === "staging" ? (i) => i.title === STAGING_TITLE : (i) => i.title.includes(hashMarker(hash)));
    } catch (e) { return fail("find", msg(e)); }
    if (open.length === 0) {
      try {
        const made = await port.createIssue({ title, body, labels: [LABEL] });
        return { ok: true, action: "created", issue: made.number, extras: [] };
      } catch (e) { return fail("create", msg(e)); }
    }
    const [first, ...rest] = open;
    try {
      await port.updateIssue(first.number, { title, body });
    } catch (e) { return fail("update", msg(e)); }
    return { ok: true, action: "updated", issue: first.number, extras: rest.map((i) => i.number) };
  } catch (e) {
    return fail("validate", msg(e));
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
    let open;
    try {
      open = await openMatching(port, server === "staging" ? (i) => i.title === STAGING_TITLE : (i) => i.title.includes(hashMarker(hash)));
    } catch (e) { return fail("find", msg(e)); }
    const comment = [`The gate passed for ${server} adapter hash \`${hash}\`${c.version ? ` (${c.version})` : ""}; the adapter is published.`, c.runUrl ? `Run: ${c.runUrl}` : null].filter(Boolean).join("\n\n");
    const closed = [];
    for (const i of open) {
      try {
        await port.closeIssue(i.number, { comment });
        closed.push(i.number);
      } catch (e) { return fail("close", msg(e), { closed }); }
    }
    return { ok: true, closed };
  } catch (e) {
    return fail("validate", msg(e));
  }
}
