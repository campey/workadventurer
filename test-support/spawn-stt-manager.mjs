// Child process for the "worker dies with a SIGKILLed parent" test (#57):
// starts a worker through the manager, prints its pid, then idles.
import { createWorkerManager } from "../src/stt-worker-proc.mjs";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./fake-stt-worker.mjs", import.meta.url));
const m = createWorkerManager({
  command: process.execPath,
  args: (sock) => [script, "--socket", sock],
  sockPath: `/tmp/fake-stt-${process.pid}.sock`,
});
await m.ensure();
console.log(`worker-pid ${m.pid}`);
setInterval(() => {}, 1 << 30);
