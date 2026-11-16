// A one-question terminal prompt for the adapter download consent flow.
// It never blocks without a terminal: a cron job, the daemon or CI answers "no".

import readline from "node:readline";

/**
 * @param {string} question
 * @param {{input?: import("node:stream").Readable, output?: import("node:stream").Writable}} [opts]
 * @returns {Promise<"yes"|"no"|"always">}
 */
export async function askYesNoAlways(question, { input = process.stdin, output = process.stderr } = {}) {
  // No terminal on either side (stdin or a redirected stderr) means no visible prompt: answer no.
  if (!input.isTTY || !output.isTTY) return "no";
  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    return await new Promise((resolve) => {
      rl.once("close", () => resolve("no")); // stdin ended with no answer
      rl.question(`${question} [y/N/always] `, (answer) => {
        const a = answer.trim().toLowerCase();
        resolve(a === "y" || a === "yes" ? "yes" : a === "a" || a === "always" ? "always" : "no");
      });
    });
  } finally {
    rl.close(); // detaches listeners and pauses input so the process can exit
  }
}
