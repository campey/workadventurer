// `wa join --stt --transcript <path>` (#64): append one JSONL line per finalized
// utterance — {"ts","speaker","text"} — to a file. Partials are not written
// (they supersede each other), and empty finals are skipped. One file per
// daemon, append-only, so it survives restarts and can be tailed.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * @param {string} file  transcript path (parent dirs are created)
 * @param {{now?: () => Date, onError?: (e: Error) => void}} [opts]
 * @returns {(e: {text: string, final: boolean}, speaker: string) => void}
 */
export function makeTranscriptSink(file, { now = () => new Date(), onError = () => {} } = {}) {
  return function onHeard({ text, final }, speaker) {
    if (!final || !text?.trim()) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ ts: now().toISOString(), speaker, text }) + "\n");
    } catch (e) {
      onError(e); // a full disk or bad path must never break live transcription
    }
  };
}
