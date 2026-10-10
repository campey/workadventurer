// Prints the live adapter's isSolid reading at each candidate landmark, so a
// person can check each one in a browser (walk into it) before it goes into the
// world's facts file. Usage:
//   node world-port/probes/run.mjs landmarks --world "<key>" --at "name:x,y" [--at ...]
// Verdict is always "new": a reading is a candidate, not a fact, until confirmed.
export default {
  question: "What does the adapter's collision map say is solid at each candidate landmark?",
  world: "afrolabs open space",
  async run(ctx) {
    const specs = ctx.args?.at ?? [];
    if (!specs.length) throw new Error('give at least one --at "name:x,y"');
    const points = specs.map((s) => {
      const m = /^(.+):(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(s);
      if (!m) throw new Error(`bad --at "${s}": expected "name:x,y"`);
      return { name: m[1], x: Number(m[2]), y: Number(m[3]) };
    });
    const a = ctx.avatar("A");
    await a.connect();
    ctx.log("A joined");
    const readings = points.map((p) => ({ ...p, solid: a.isSolid(p.x, p.y) }));
    return {
      observed: { readings },
      verdict: "new",
      note: 'candidates only: walk into each in a browser, then record confirmed ones as confirmedBy: "campey, browser, <date>" in the world\'s facts file, or drop them',
    };
  },
};
