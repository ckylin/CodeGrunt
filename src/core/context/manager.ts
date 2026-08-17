import type { Message } from '../../types.js';

const CHARS_PER_TOKEN = 4;

// ── Append-only strategy ───────────────────────────────────────────────────
//
// v0.6 changes:
// - NO automatic splicing from the front (preserves DeepSeek prefix cache).
// - `needsCompact` is flagged when approaching budget, but compaction is
//   ONLY triggered by user-initiated `/compact` or auto-compact in the agent
//   loop — never by a push/setMessages call.
// - SOFT TRIM: if grossly over budget (e.g., a single massive tool result
//   exceeds 2× budget), trim from the END of messages (not the front), which
//   preserves the prefix cache.
// - WARNING at 95% budget: display a visual warning to encourage `/compact`.

// Signal compaction at this fraction of the budget (70%).
const AUTO_COMPACT_THRESHOLD = 0.70;
// Also signal when non-system message count exceeds this number.
const AUTO_COMPACT_MESSAGE_COUNT = 40;
// Emergency hard limit: token count must exceed budget by this factor before
// soft-trimming from the end. Set high (2.0) to keep prefix intact in normal
// operation; prevents OOM only in extreme cases.
const EMERGENCY_TRIM_FACTOR = 2.0;
// Warning threshold: show user-visible warning at this fraction of budget (95%).
const WARN_THRESHOLD = 0.95;

export class ContextManager {
  private messages: Message[] = [];
  private tokenBudget: number;
  /** Set to true when the context is near capacity and should be compacted before the next agent turn. */
  needsCompact = false;
  /** Set to true when near 95% capacity — caller should show a warning. */
  nearCapacity = false;
  /** Accumulated cache statistics for this session */
  private _cacheStats: CacheStats = { roundHits: 0, roundMisses: 0, totalHits: 0, totalMisses: 0, costSaved: 0 };

  /**
   * @param tokenBudget Maximum estimated tokens for stored messages.
   *                    For DeepSeek-V4 (128K context), default ~90K leaves room for output.
   *                    For R1 reasoner (1M context), can go much higher.
   */
  constructor(tokenBudget = 90_000) {
    this.tokenBudget = tokenBudget;
  }

  push(message: Message): void {
    this.messages.push(message);
    this.checkCapacity();
  }

  getMessages(): Message[] {
    return this.messages;
  }

  clear(): void {
    this.messages = [];
    this.needsCompact = false;
    this.nearCapacity = false;
  }

  /** Replace messages wholesale (used for cache-warm restart) */
  setMessages(msgs: Message[]): void {
    this.messages = msgs;
    this.checkCapacity();
  }

  estimatedTokenCount(): number {
    return this.estimateTokens();
  }

  /** Returns the token budget */
  getTokenBudget(): number {
    return this.tokenBudget;
  }

  /** Returns the percentage of budget used (0–100) */
  budgetUsagePercent(): number {
    return (this.estimateTokens() / this.tokenBudget) * 100;
  }

  /** Returns true if the context is over 95% of its budget */
  isNearCapacity(): boolean {
    return this.nearCapacity;
  }

  /** Adjust the token budget dynamically (e.g. when switching models) */
  setTokenBudget(budget: number): void {
    this.tokenBudget = budget;
    this.checkCapacity();
  }

  /**
   * Compact: replace current messages with a summary.
   * Preserves the system message (if any), adds the summary as a user
   * message, and appends an assistant acknowledgment.
   * Ref: src/core/context/compact.ts
   */
  compact(summary: string): void {
    const systemMsg = this.messages.find(m => m.role === 'system');
    this.messages = [];
    if (systemMsg) this.messages.push(systemMsg);
    this.messages.push({
      role: 'user',
      content: `[Previous conversation summary]\n${summary}`,
    });
    this.messages.push({
      role: 'assistant',
      content: 'Understood. I have the context from our previous conversation and am ready to continue.',
    });
    this.needsCompact = false;
    this.nearCapacity = false;
  }

  // ── Cache stats API (v0.6 new) ──────────────────────────────────────────

  getCacheStats(): CacheStats {
    return { ...this._cacheStats };
  }

  /** Record cache hit/miss data from a single LLM call */
  recordCacheUsage(hitTokens: number, missTokens: number, costSaved: number): void {
    this._cacheStats.roundHits = hitTokens;
    this._cacheStats.roundMisses = missTokens;
    this._cacheStats.totalHits += hitTokens;
    this._cacheStats.totalMisses += missTokens;
    this._cacheStats.costSaved += costSaved;
  }

  /** Reset per-round cache stats (called at the start of each agent turn) */
  resetRoundCacheStats(): void {
    this._cacheStats.roundHits = 0;
    this._cacheStats.roundMisses = 0;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private estimateTokens(): number {
    let total = 0;
    for (const msg of this.messages) {
      if ('content' in msg && msg.content) {
        total += Math.ceil(String(msg.content).length / CHARS_PER_TOKEN);
      }
      // Account for reasoning_content in token count
      if ('reasoning_content' in msg && msg.reasoning_content) {
        total += Math.ceil(String(msg.reasoning_content).length / CHARS_PER_TOKEN);
      }
      // Tool calls consume tokens
      if ('tool_calls' in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          total += Math.ceil(tc.function.name.length / CHARS_PER_TOKEN);
          total += Math.ceil(tc.function.arguments.length / CHARS_PER_TOKEN);
        }
      }
    }
    return total;
  }

  /**
   * v0.6 Append-only check: NEVER splice from the front.
   *
   * - Signals needsCompact when approaching budget (70% or 40+ messages).
   * - Sets nearCapacity when at 95%+ budget (caller shows warning).
   * - Emergency soft-trim from the END only when grossly over budget (2×),
   *   protecting the prefix cache.
   */
  private checkCapacity(): void {
    const tokens = this.estimateTokens();
    const nonSystemCount = this.messages.filter(m => m.role !== 'system').length;

    // Signal that compaction is needed — do NOT splice here.
    if (
      tokens > this.tokenBudget * AUTO_COMPACT_THRESHOLD ||
      nonSystemCount > AUTO_COMPACT_MESSAGE_COUNT
    ) {
      this.needsCompact = true;
    }

    // Warning threshold — caller can display a user-visible warning.
    this.nearCapacity = tokens > this.tokenBudget * WARN_THRESHOLD;

    // Emergency hard limit: only soft-trim from the END when grossly over budget.
    // This preserves the prefix cache because we never touch the front messages.
    const hardLimit = this.tokenBudget * EMERGENCY_TRIM_FACTOR;
    if (this.estimateTokens() > hardLimit) {
      this.softTrimFromEnd(hardLimit);
    }
  }

  /**
   * Soft-trim from the END of the message list (not the front), protecting
   * the prefix cache at the front.
   *
   * The newest message group is exempt from trimming: checkCapacity() runs
   * synchronously right after every push(), so on the call that pushes the
   * message which tips us over the hard limit, that same message would
   * otherwise be the very first thing removed — the caller's push() would
   * silently lose the data it just added (e.g. a tool result the pipeline
   * is about to reference). Trimming instead starts at the group just
   * before the newest one and works backward, so it can still shed older
   * groups from the tail but never the one that was just appended.
   */
  private softTrimFromEnd(hardLimit: number): void {
    const systemCount = this.messages[0]?.role === 'system' ? 1 : 0;
    const minMessages = systemCount + 4; // keep at least 4 non-system messages

    let boundary = this.findGroupStart(this.messages.length - 1);

    while (
      this.estimateTokens() > hardLimit &&
      this.messages.length > minMessages &&
      boundary > minMessages
    ) {
      const groupStart = this.findGroupStart(boundary - 1);
      const removeCount = boundary - groupStart;
      if (removeCount <= 0) break;
      this.messages.splice(groupStart, removeCount);
      boundary -= removeCount;
    }
  }

  /**
   * Given an index, return the start index of the message group it belongs
   * to: a plain message is its own group; an assistant(tool_calls) message
   * plus the tool results that answer it form a single group that must be
   * removed (or kept) together to stay API-valid.
   */
  private findGroupStart(fromIdx: number): number {
    if (fromIdx < 0) return 0;
    const msg = this.messages[fromIdx];
    if (msg.role === 'tool') {
      let start = fromIdx;
      while (start > 0 && this.messages[start - 1].role === 'tool') {
        start--;
      }
      const prev = start > 0 ? this.messages[start - 1] : undefined;
      if (prev && prev.role === 'assistant' && 'tool_calls' in prev && prev.tool_calls) {
        start--;
      }
      return start;
    }
    return fromIdx;
  }
}

// ── Cache statistics type (v0.6 new) ────────────────────────────────────────

export interface CacheStats {
  /** Cache hit tokens from the most recent LLM call */
  roundHits: number;
  /** Cache miss tokens from the most recent LLM call */
  roundMisses: number;
  /** Cumulative cache hit tokens for the entire session */
  totalHits: number;
  /** Cumulative cache miss tokens for the entire session */
  totalMisses: number;
  /** Estimated cost saved by cache hits (USD) */
  costSaved: number;
}
