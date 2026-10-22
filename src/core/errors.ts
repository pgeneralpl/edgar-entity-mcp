export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "UPSTREAM_ERROR"
  | "RATE_LIMITED"
  | "UNSUPPORTED"
  | "UNAUTHORIZED"
  | "CONFIG_ERROR"
  | "INTERNAL";

/** An error whose message is safe and useful to show to the calling agent. */
export class ToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

/** Mask credential-looking substrings (tokens, passwords, bearer values, API keys) before logging. */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(bearer)\s+[^\s"']+/gi, "$1 [redacted]")
    .replace(/\b(token|password|passwd|secret|api[_-]?key|authorization)(["']?\s*[=:]\s*["']?)[^\s"'&,]+/gi, "$1$2[redacted]")
    .replace(/\beem_[A-Za-z0-9]{32}\b/g, "eem_[redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@");
}

/**
 * Remove personal or request-derived data before logging: URL query strings and fragments (they
 * carry tool arguments such as searched names), IPv4/IPv6 addresses, and email addresses.
 */
export function redactPersonal(s: string): string {
  return s
    .replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/gi, "$1?[redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .replace(/\b(?:[0-9a-f]{1,4}:){2,7}(?::|[0-9a-f]{1,4})(?::[0-9a-f]{1,4})*\b/gi, "[ip]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]");
}

/** Log full error details server-side only (stderr → platform logs). Returns a short correlation id. */
export function logError(context: string, err: unknown): string {
  const id = Math.random().toString(36).slice(2, 10);
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(JSON.stringify({ type: "error", id, context, ts: new Date().toISOString(), detail: redactPersonal(redactSecrets(detail)).slice(0, 2000) }) + "\n");
  return id;
}

/**
 * Map any error to a ToolError that is safe to return to callers.
 * ToolErrors pass through; upstream HTTP errors get a status-based message (public URLs only);
 * anything else becomes a generic INTERNAL error with details logged server-side.
 */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof HttpError) {
    if (err.status === 404) return new ToolError("NOT_FOUND", `Not found upstream: ${err.url}`);
    if (err.status === 403 && /sec\.gov/.test(err.url))
      return new ToolError(
        "UPSTREAM_ERROR",
        "SEC rejected the request (403). This usually means the User-Agent is missing/invalid or the IP is temporarily blocked for exceeding 10 req/s.",
        "Set SEC_USER_AGENT to '<Company or Name> <email>' and retry later.",
      );
    if (err.status === 429) return new ToolError("RATE_LIMITED", "Upstream rate limit hit.", "Retry in a few seconds.", { retry_after_seconds: 5 });
    logError("upstream", err);
    return new ToolError("UPSTREAM_ERROR", `Upstream returned HTTP ${err.status}.`, "Retry later; the SEC or state portal may be having issues.");
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return new ToolError("UPSTREAM_ERROR", "Upstream request timed out.", "Retry; SEC/state portals are occasionally slow.");
  const id = logError("internal", err);
  return new ToolError("INTERNAL", `Internal error (ref ${id}).`);
}
