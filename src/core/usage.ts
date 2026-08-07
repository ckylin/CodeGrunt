// ── Session and per-call usage tracking ─────────────────────────────────────
// Extracted from loop.ts so that pipeline stages and providers can both access
// usage data without creating circular imports.
//
// Invariant: lastCallUsage is updated by addUsage() on every provider call,
// which always happens before StreamResponseStage reads it.
//
// This module is the SINGLE source of truth for both UsageStats and PRICING.
// Do NOT redefine either in billing.ts or provider.ts.

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** Calculated cost in USD (set by the caller, e.g. after pricing lookup) */
  cost: number;
}

// ── DeepSeek pricing (USD per 1M tokens) ────────────────────────────────────
// Source: https://api-docs.deepseek.com/quick_start/pricing (checked 2026-07-20)
//
// `deepseek-chat` and `deepseek-reasoner` are deprecated as of 2026-07-24
// 15:59 UTC — they are backward-compat aliases for the non-thinking and
// thinking modes of `deepseek-v4-flash`, NOT separately-priced models.
// Thinking mode does not change the per-token rate; it only affects how
// many output tokens a response generates. v4-pro is ~3x v4-flash's rate.

export const V4_FLASH_PRICE = { prompt: 0.14, completion: 0.28, cacheHit: 0.0028 } as const;
export const V4_PRO_PRICE = { prompt: 0.435, completion: 0.87, cacheHit: 0.003625 } as const;

export type PriceEntry = { prompt: number; completion: number; cacheHit: number };

export const PRICING: Record<string, PriceEntry> = {
  'deepseek-chat':     V4_FLASH_PRICE, // deprecated alias — see note above
  'deepseek-v4-flash': V4_FLASH_PRICE,
  'deepseek-v4-pro':   V4_PRO_PRICE,
  'deepseek-reasoner': V4_FLASH_PRICE, // deprecated alias — see note above
};

/** Calculate the USD cost for a single API call given pricing and token counts. */
export function calculateCost(
  pricing: PriceEntry,
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens: number,
): number {
  const inputCost = (inputTokens / 1_000_000) * pricing.prompt;
  const outputCost = (outputTokens / 1_000_000) * pricing.completion;
  const cacheSavings = (cacheHitTokens / 1_000_000) * (pricing.prompt - pricing.cacheHit);
  return inputCost + outputCost - cacheSavings;
}

// ── Module-level state ───────────────────────────────────────────────────────

const sessionUsage: UsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  cost: 0,
};

let lastCallUsage: UsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  cost: 0,
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
  sessionUsage.cost           += u.cost;
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
