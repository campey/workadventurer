// Re-tests the "When prod bumps" note in docs/field-notes.md: prod accepts
// apiVersionHash 23c8eb8c and answers 05489a87 with errorScreen NEW_VERSION.
const ACCEPTED = "23c8eb8c";
const STALE = "05489a87";

async function attempt(avatar) {
  try {
    await avatar.connect();
    return { joined: true };
  } catch (e) {
    // Only a server answer is evidence; a network/transport failure is not.
    if (e.name !== "ServerRejectedError") throw e;
    return { joined: false, error: e.name, code: e.code ?? null, message: e.message };
  }
}

export default {
  question: `Does prod accept ${ACCEPTED} and turn away ${STALE} with a new-version error?`,
  world: "afrolabs open space",
  async run(ctx) {
    const a = ctx.avatar("A", { versionHash: ACCEPTED });
    const accepted = await attempt(a);
    ctx.log(`${ACCEPTED}: ${accepted.joined ? "joined" : accepted.message}`);
    const b = ctx.avatar("B", { versionHash: STALE });
    const stale = await attempt(b);
    ctx.log(`${STALE}: ${stale.joined ? "joined" : stale.message}`);
    const confirms = accepted.joined && !stale.joined && stale.code === "NEW_VERSION";
    return {
      observed: { [ACCEPTED]: accepted, [STALE]: stale },
      verdict: confirms ? "confirms" : "contradicts",
      note: confirms
        ? "accepted hash joined; stale hash got NEW_VERSION"
        : "outcome differs from the note; check observed and correct docs/field-notes.md",
    };
  },
};
