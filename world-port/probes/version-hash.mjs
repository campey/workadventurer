import { waitFor } from "../port.mjs";

// Re-tests the "When prod bumps" note in docs/field-notes.md: prod accepts
// apiVersionHash 23c8eb8c and answers 05489a87 with errorScreen NEW_VERSION.
const ACCEPTED = "23c8eb8c";
const STALE = "05489a87";

// Conclusive outcomes only: joined, or a ServerRejectedError (at connect, or
// right after the join). Anything else (network failure) throws.
async function attempt(avatar, { watchLateRejection = false } = {}) {
  const late = watchLateRejection ? waitFor(avatar, "rejected", () => true, 5000).catch(() => null) : null;
  try {
    await avatar.connect();
  } catch (e) {
    if (e.name !== "ServerRejectedError") throw e;
    return { joined: false, code: e.code ?? null, message: e.message };
  }
  const rej = late ? await late : null;
  return rej ? { joined: false, code: rej.code ?? null, message: rej.message } : { joined: true };
}

const verdictFor = (accepted, stale) => {
  for (const [hash, r] of [[ACCEPTED, accepted], [STALE, stale]]) {
    if (!r.joined && r.code !== "NEW_VERSION") {
      throw new Error(`inconclusive: ${hash} was rejected with code ${r.code} (${r.message})`);
    }
  }
  if (!accepted.joined) return ["contradicts", `${ACCEPTED} was rejected with NEW_VERSION`];
  if (stale.joined) return ["contradicts", `${STALE} joined and was not rejected within 5s`];
  return ["confirms", "accepted hash joined; stale hash got NEW_VERSION"];
};

export default {
  question: `Does prod accept ${ACCEPTED} and turn away ${STALE} with a new-version error?`,
  world: "afrolabs open space",
  async run(ctx) {
    const a = ctx.avatar("A", { versionHash: ACCEPTED });
    const accepted = await attempt(a, { watchLateRejection: true });
    ctx.log(`${ACCEPTED}: ${accepted.joined ? "joined" : accepted.message}`);
    const b = ctx.avatar("B", { versionHash: STALE });
    const stale = await attempt(b, { watchLateRejection: true });
    ctx.log(`${STALE}: ${stale.joined ? "joined" : stale.message}`);
    const [verdict, note] = verdictFor(accepted, stale);
    return { observed: { [ACCEPTED]: accepted, [STALE]: stale }, verdict, note };
  },
};
