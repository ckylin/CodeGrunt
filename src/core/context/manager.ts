import type { Message } from '../../types.js';

const CHARS_PER_TOKEN = 4;
// Signal compaction when estimated tokens exceed this fraction of the budget.
// Every compact() call replaces the message array wholesale, which invalidates
// DeepSeek's prefix cache — so triggering less often (higher threshold) trades
// a bit of headroom for a much better overall cache hit rate.
const AUTO_COMPACT_THRESHOLD = 0.70;
// Also signal when non-system message count exceeds this number.
const AUTO_COMPACT_MESSAGE_COUNT = 40;
// Emergency hard limit: only splice when tokens exceed budget by this factor.
// Keeps prefix cache intact in normal operation; prevents OOM in extreme cases.
const EMERGENCY_TRIM_FACTOR = 2.0;

export class ContextManager {
  private messages: Message[] = [];
  private tokenBudget: number;
  /** Set to true when the context is near capacity and should be compacted before the next agent turn. */
  needsCompact = false;

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
    this.trim();
  }

  getMessages(): Message[] {
    return this.messages;
  }

  clear(): void {
    this.messages = [];
  }

  /** Replace messages wholesale (used for cache-warm restart) */
  setMessages(msgs: Message[]): void {
    this.messages = msgs;
    this.trim();
  }

  estimatedTokenCount(): number {
    return this.estimateTokens();
  }

  /** Adjust the token budget dynamically (e.g. when switching models) */
  setTokenBudget(budget: number): void {
    this.tokenBudget = budget;
    this.trim();
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
  }

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

  private trim(): void {
    const tokens = this.estimateTokens();
    const nonSystemCount = this.messages.filter(m => m.role !== 'system').length;

    // Signal that compaction is needed — do NOT splice here.
    // Splicing old messages shifts the prefix and invalidates DeepSeek's KV cache.
    // The caller (agent loop) is responsible for running compact() before the next turn.
    if (
      tokens > this.tokenBudget * AUTO_COMPACT_THRESHOLD ||
      nonSystemCount > AUTO_COMPACT_MESSAGE_COUNT
    ) {
      this.needsCompact = true;
    }

    // Emergency hard limit: only splice when grossly over budget (e.g. a single
    // massive tool result). This is a last resort — normal sessions should never
    // hit this path because compact() is triggered well before this point.
    const hardLimit = this.tokenBudget * EMERGENCY_TRIM_FACTOR;
    if (this.estimateTokens() > hardLimit) {
      const hasSystem = this.messages[0]?.role === 'system';
      const startIdx = hasSystem ? 1 : 0;
      const minMessages = hasSystem ? 5 : 4;
      while (this.estimateTokens() > hardLimit && this.messages.length > minMessages) {
        this.removeOldestGroup(startIdx);
      }
    }
  }

  /**
   * Remove the oldest message group from the conversation, preserving
   * assistant(tool_calls) ↔ tool message pairing required by the LLM API.
   */
  private removeOldestGroup(startIdx: number): void {
    const msg = this.messages[startIdx];

    if (msg && msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
      // This is an assistant message with tool calls — must remove it
      // together with all subsequent tool response messages.
      let removeCount = 1;
      while (
        startIdx + removeCount < this.messages.length &&
        this.messages[startIdx + removeCount].role === 'tool'
      ) {
        removeCount++;
      }
      this.messages.splice(startIdx, removeCount);
    } else if (msg && msg.role === 'tool') {
      // Tool message at trim boundary. If the preceding message is an
      // assistant(tool_calls), we must remove them together to avoid
      // sending an orphaned tool_calls to the API (which triggers a 400
      // error: "insufficient tool messages following tool_calls message").
      const prev = startIdx > 0 ? this.messages[startIdx - 1] : undefined;
      if (
        prev &&
        prev.role === 'assistant' &&
        'tool_calls' in prev &&
        prev.tool_calls
      ) {
        // Remove assistant(tool_calls) + all contiguous following tool messages
        let removeCount = 2; // assistant + this tool
        while (
          startIdx + removeCount - 1 < this.messages.length &&
          this.messages[startIdx + removeCount - 1].role === 'tool'
        ) {
          removeCount++;
        }
        this.messages.splice(startIdx - 1, removeCount);
      } else {
        // Standalone tool message without preceding assistant(tool_calls) —
        // this can happen if the assistant was already removed. Skip it
        // to avoid breaking the stream, and also skip any contiguous tool messages.
        let removeCount = 1;
        while (
          startIdx + removeCount < this.messages.length &&
          this.messages[startIdx + removeCount].role === 'tool'
        ) {
          removeCount++;
        }
        this.messages.splice(startIdx, removeCount);
      }
    } else {
      // Plain message (user, assistant without tool_calls, system) — safe to remove
      this.messages.splice(startIdx, 1);
    }
  }
}
