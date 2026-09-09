// Stream text to stdout one character at a time, paced to fill `seconds`,
// like watching tokens arrive. Used by intro-sequence.sh to print a clip's
// transcript while the audio plays.
//
//   node scripts/typewriter.mjs "some text" 4.2
const [, , text = "", secs = "3"] = process.argv;
const total = Math.max(0.3, Number(secs) || 3);
const chars = [...text];
const per = (total * 1000) / Math.max(1, chars.length);

for (const ch of chars) {
  process.stdout.write(ch);
  // group the sleep for whitespace so words feel like words
  const wait = ch === " " ? per * 1.5 : per;
  await new Promise((r) => setTimeout(r, wait));
}
process.stdout.write("\n");
