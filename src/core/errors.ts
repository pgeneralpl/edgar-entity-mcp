export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "UPSTREAM_ERROR"
  | "RATE_LIMITED"
  | "UNSUPPORTED"
  | "UNAUTHORIZED"
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
    if (err.status === 429) return new ToolError("RATE_LIMITED", `Upstream rate limit hit: ${err.url}`, "Retry in a few seconds.");
    return new ToolError("UPSTREAM_ERROR", err.message);
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError")
      return new ToolError("UPSTREAM_ERROR", "Upstream request timed out.", "Retry; SEC/state portals are occasionally slow.");
    return new ToolError("INTERNAL", err.message);
  }
  return new ToolError("INTERNAL", String(err));
}
