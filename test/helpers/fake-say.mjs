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
