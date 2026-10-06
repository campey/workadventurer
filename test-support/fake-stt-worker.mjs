// Stand-in for scripts/stt_worker.py in lifecycle tests (issue #57): prints the
// same "listening on" line, then behaves like the real worker's contract —
// exit when the parent goes away (stdin EOF) or on SIGTERM.
console.error(`listening on ${process.argv[3] ?? "?"}`);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30); // stay alive
