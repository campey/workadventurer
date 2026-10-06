// Run the fake pusher standalone: node scripts/fake-pusher.mjs [port]
// Prints the connection count every 5s. Used for the #56 daemon repro.
import { startFakePusher } from "../test/helpers/fake-pusher.mjs";

// usage: node scripts/fake-pusher.mjs [port] [code] [timeToRetry] [joinFirstMs]
const [, , port, code, ttr] = process.argv;
const p = await startFakePusher({
  listenPort: Number(port) || 0,
  ...(code && { code }),
  ...(ttr && { timeToRetry: Number(ttr) }),
  joinFirstMs: Number(process.argv[5]) || 0,
});
console.log(`fake pusher on ${p.url} (room ${p.roomUrl})`);
const t0 = Date.now();
setInterval(() => {
  console.log(`t+${Math.round((Date.now() - t0) / 1000)}s connections=${p.stats.connections} logins=${p.stats.logins}`);
}, 5000);
