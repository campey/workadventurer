// Typed form of the pusher's `errorScreenMessage` (issue #56).
//
// The proto's string/int fields are google.protobuf.*Value wrappers, so they
// arrive as `{ value: … }` — unwrap before use. The server also says whether
// auto-retry is pointless (`type: "retry"`, a huge `timeToRetry`), which the
// daemon must honour.

// Codes where retrying can never help: the server is refusing this client
// build. Anything not listed keeps the bounded retry.
export const FATAL_CODES = new Set(["NEW_VERSION"]);

// A server-supplied timeToRetry at or above this (seconds) means "don't".
// WA sends 999999 alongside NEW_VERSION.
export const FATAL_TIME_TO_RETRY_S = 3600;

const unwrap = (w) => (w && typeof w === "object" && "value" in w ? w.value : w) ?? null;

export class ServerRejectedError extends Error {
  constructor({ code = null, title = null, details = null, subtitle = null, timeToRetry = null } = {}) {
    const text = [title, details ?? subtitle].filter(Boolean).join(" — ");
    super(`server error screen: ${text || "(no text)"}${code ? ` (${code})` : ""}`);
    this.name = "ServerRejectedError";
    this.code = code;
    this.timeToRetry = timeToRetry;
    this.retryable = !(
      (code && FATAL_CODES.has(code)) ||
      (timeToRetry != null && timeToRetry >= FATAL_TIME_TO_RETRY_S)
    );
  }

  /** Build from a decoded `errorScreenMessage` (wrapper-valued fields). */
  static fromMessage(m = {}) {
    return new ServerRejectedError({
      code: unwrap(m.code),
      title: unwrap(m.title),
      details: unwrap(m.details),
      subtitle: unwrap(m.subtitle),
      timeToRetry: unwrap(m.timeToRetry),
    });
  }
}

/** True when the server rejected our apiVersionHash. Keys on the code, not the text. */
export const isVersionRejection = (e) => e instanceof ServerRejectedError && e.code === "NEW_VERSION";
