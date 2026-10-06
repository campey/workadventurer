// Scoring for the STT quality corpus (issue #61): word error rate against the
// expected text, plus the hallucination signatures seen live — any final on a
// must-be-empty clip, wrong-script output, and token-run loops.

export function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word-level Levenshtein distance / reference length; null if the reference is empty. */
export function wer(expected, actual) {
  const ref = normalizeWords(expected);
  const hyp = normalizeWords(actual);
  if (ref.length === 0) return null;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[hyp.length] / ref.length;
}

const hasNonLatinLetter = (s) => /[\p{L}\uFFFD]/u.test(s.replace(/\p{Script=Latin}/gu, ""));

function hasLoop(words, minRun = 4) {
  let run = 1;
  for (let i = 1; i < words.length; i++) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= minRun) return true;
  }
  return false;
}

/**
 * @param {{expected: string|null, finals: string[]}} clip  expected "" = must produce nothing
 * @returns {{wer: number|null, spurious: number, nonLatin: boolean, loop: boolean, text: string}}
 */
export function scoreClip({ expected: rawExpected, finals }) {
  // null = real recording with no known reference: only script/loop are checked
  const expected = rawExpected ?? "x";
  const noReference = rawExpected === null;
  const nonEmpty = finals.filter((f) => f.trim());
  const text = nonEmpty.join(" ");
  return {
    text,
    wer: noReference ? null : wer(expected, text),
    spurious: !noReference && normalizeWords(expected).length === 0 ? nonEmpty.length : 0,
    nonLatin: !hasNonLatinLetter(expected) && hasNonLatinLetter(text),
    loop: hasLoop(normalizeWords(text)) || /(.{1,12}?)\1{5,}/u.test(text), // word run, or a substring (1-12 chars) 6+ times in a row
  };
}
