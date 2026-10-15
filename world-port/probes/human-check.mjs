// Ask the person watching in a browser, answered by emote: 👍 = yes/good,
// 😂 = no/wrong. The avatar shows the question in a speech bubble; nothing
// moves on until someone answers (or the wait times out). Emotes from our own
// probe avatars (wa-probe-*) are ignored.
//
// Used for checks only a person can make, e.g. "did I stop at the wall?" —
// the server never enforces collisions, so no probe can see it.

export const GOOD = /👍/;
export const WRONG = /😂|🤣/;

/** Show `prompt` on `avatar` and resolve "good" | "wrong" | "no answer". */
export function askHuman(avatar, prompt, { timeoutMs = 180000, log = () => {} } = {}) {
  avatar.speechBubble(`${prompt} — 👍 good / 😂 wrong`);
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); avatar.off("emote", onEmote); avatar.clearBubble(); resolve(v); };
    const onEmote = (e) => {
      if ((e.name ?? "").startsWith("wa-probe-")) return;
      const v = GOOD.test(e.emote) ? "good" : WRONG.test(e.emote) ? "wrong" : null;
      log(`  emote from ${e.name || "?"}: ${e.emote}${v ? ` -> ${v}` : " (ignored)"}`);
      if (v) done(v);
    };
    const timer = setTimeout(() => done("no answer"), timeoutMs);
    avatar.on("emote", onEmote);
  });
}
