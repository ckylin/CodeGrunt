// ── Session and per-call usage tracking ─────────────────────────────────────
// Extracted from loop.ts so that pipeline stages and providers can both access
// usage data without creating circular imports.
//
// Invariant: lastCallUsage is updated by addUsage() on every provider call,
// which always happens before StreamResponseStage reads it.

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

// ── Module-level state ───────────────────────────────────────────────────────

const sessionUsage: UsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
};

let lastCallUsage: UsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
};

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Record usage from a single LLM call. Updates both the cumulative session
 * totals and the per-call snapshot accessible via getLastCallUsage().
 */
export function addUsage(u: UsageStats): void {
  sessionUsage.inputTokens    += u.inputTokens;
  sessionUsage.outputTokens   += u.outputTokens;
  sessionUsage.cacheHitTokens += u.cacheHitTokens;
  sessionUsage.cacheMissTokens += u.cacheMissTokens;
  // Snapshot the per-call stats so StreamResponseStage can read them after the stream
  lastCallUsage = { ...u };
}

/** Returns a copy of the cumulative session-level usage totals. */
export function getSessionUsage(): UsageStats {
  return { ...sessionUsage };
}

/**
 * Returns a copy of the usage stats from the most recent LLM call.
 * These are the real per-call values (including cache hit/miss from DeepSeek).
 */
export function getLastCallUsage(): UsageStats {
  return { ...lastCallUsage };
}
