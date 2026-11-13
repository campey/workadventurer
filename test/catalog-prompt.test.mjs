import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { askYesNoAlways } from "../src/catalog/prompt.mjs";

function tty() {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let written = "";
  output.on("data", (d) => (written += d));
  return { input, output, written: () => written };
}

for (const [line, want] of [
  ["y", "yes"],
  ["YES", "yes"],
  ["always", "always"],
  ["a", "always"],
  ["", "no"],
  ["n", "no"],
  ["maybe", "no"],
]) {
  test(`askYesNoAlways: ${JSON.stringify(line)} -> ${want}`, async () => {
    const { input, output, written } = tty();
    const p = askYesNoAlways("Download adapter?", { input, output });
    input.write(line + "\n");
    assert.equal(await p, want);
    assert.match(written(), /Download adapter\?.*\[y\/N\/always\]/);
  });
}

test("askYesNoAlways: closed stdin with no answer is no", async () => {
  const { input, output } = tty();
  const p = askYesNoAlways("q", { input, output });
  input.end();
  assert.equal(await p, "no");
});

test("askYesNoAlways: non-TTY input resolves no at once, without reading or writing", async () => {
  const input = new PassThrough(); // isTTY undefined
  const output = new PassThrough();
  let written = "";
  output.on("data", (d) => (written += d));
  const result = await Promise.race([
    askYesNoAlways("q", { input, output }),
    new Promise((r) => setTimeout(() => r("timeout"), 50)),
  ]);
  assert.equal(result, "no");
  assert.equal(written, "");
  assert.equal(input.listenerCount("data"), 0);
});

test("askYesNoAlways: detaches from the input after answering", async () => {
  const { input, output } = tty();
  const p = askYesNoAlways("q", { input, output });
  input.write("y\n");
  await p;
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("keypress"), 0);
});
