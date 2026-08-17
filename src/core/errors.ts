// ── Centralized Error Types ──────────────────────────────────────────────────
// Custom error classes for the CodeGrunt codebase. Using typed errors instead
// of plain `new Error(...)` makes error handling more predictable and allows
// callers to distinguish between transient, fatal, and user-facing errors.

/**
 * Base class for all CodeGrunt errors.
 * Extends the native Error with a `code` property for programmatic matching.
 */
export class CodeGruntError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CodeGruntError';
  }
}

/**
 * An error that can be retried (e.g. network timeout, 429 rate limit).
 * The caller should back off and retry instead of failing permanently.
 */
export class RetryableError extends CodeGruntError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'RETRYABLE', options);
    this.name = 'RetryableError';
  }
}

/**
 * API-level error from the DeepSeek provider (non-retryable status codes:
 * 400, 401, 403, 404). Carries the HTTP status for logging/diagnostics.
 */
export class ApiError extends CodeGruntError {
  constructor(
    message: string,
    public readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, 'API_ERROR', options);
    this.name = 'ApiError';
  }
}

/**
 * User-facing validation error (bad input, invalid config, etc.).
 * These should be surfaced directly to the user without a stack trace.
 */
export class ValidationError extends CodeGruntError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'VALIDATION', options);
    this.name = 'ValidationError';
  }
}

/**
 * Operation was cancelled by the user (Ctrl+C, Esc, or AbortSignal).
 * Distinct from AbortError so callers can handle user cancellation
 * differently from system-initiated aborts.
 */
export class UserAbortError extends CodeGruntError {
  constructor(message = 'Operation cancelled by user', options?: ErrorOptions) {
    super(message, 'USER_ABORT', options);
    this.name = 'UserAbortError';
  }
}

/**
 * Tool execution error — wraps a tool name and the underlying cause.
 * Used when a tool.execute() throws, so the pipeline can attach context
 * before re-throwing or logging.
 */
export class ToolError extends CodeGruntError {
  constructor(
    public readonly toolName: string,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, 'TOOL_ERROR', { cause });
    this.name = 'ToolError';
  }
}

/**
 * Timeout error — an operation exceeded its deadline.
 */
export class TimeoutError extends CodeGruntError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'TIMEOUT', options);
    this.name = 'TimeoutError';
  }
}

// ── User-facing error formatting ─────────────────────────────────────────────
// Maps our typed errors (and any error that slips through untyped) to a short
// label + message pair for terminal display. Kept here rather than in
// utils/display.ts so the error-type knowledge lives next to the error
// classes themselves — display.ts just calls this and prints the result.

export interface FormattedError {
  /** Short category label shown before the message, e.g. "network", "api". */
  label: string;
  message: string;
}

export function formatErrorForDisplay(err: unknown): FormattedError {
  if (err instanceof RetryableError) {
    return { label: 'network', message: `${err.message} (retried 3x, still failing — check your connection or DeepSeek's status page)` };
  }
  if (err instanceof ApiError) {
    const hint = err.status === 401 ? ' (check your API key with /config)'
      : err.status === 403 ? ' (access denied — check your account permissions)'
      : err.status === 404 ? ' (check the model name with /model)'
      : '';
    return { label: 'api', message: `${err.message}${hint}` };
  }
  if (err instanceof ValidationError) {
    return { label: 'config', message: err.message };
  }
  if (err instanceof ToolError) {
    return { label: 'tool', message: `${err.toolName}: ${err.message}` };
  }
  if (err instanceof TimeoutError) {
    return { label: 'timeout', message: err.message };
  }
  if (err instanceof UserAbortError) {
    return { label: 'cancelled', message: err.message };
  }
  return { label: 'error', message: err instanceof Error ? err.message : String(err) };
}
