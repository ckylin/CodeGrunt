// ── Context Compaction ──────────────────────────────────────────────────────
// Hierarchical summarization with chunking for large conversations.
// Handles reasoner model compatibility (R1 models reject system role).
//
// Architecture:
//   1. Format messages with full tool call / reasoning context
//   2. Split into ~6000 token chunks, keep recent N messages intact
//   3. Summarize each chunk → merge summaries if multiple chunks
//   4. Produce final summary string for ContextManager.compact()
//
// Ref: src/core/context/manager.ts for token estimation
// Ref: src/providers/deepseek/provider.ts for stream API
// Ref: src/core/pipeline/stages/prepare-context.ts L103 for reasoner pattern

import chalk from 'chalk';
import type { LLMProvider, Message, StreamChunk } from '../../types.js';

// ── Constants ───────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;
const CHUNK_TOKENS = 6_000;        // max tokens per chunk
const CHUNK_SUMMARY_TOKENS = 400;  // max tokens for each chunk summary
const FINAL_SUMMARY_TOKENS = 1500; // max tokens for merged final summary
const KEEP_RECENT = 15;            // keep last N messages uncompressed
const MIN_MESSAGES = 4;            // minimum non-system messages before compacting

// ── Message formatting ──────────────────────────────────────────────────────

/** Truncate a string to approximately maxChars, adding ellipsis if cut. */
function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '…';
}

/**
 * Format a single message for the summarization prompt.
 * Preserves tool call names/args, tool result context, and reasoning_content.
 * Ref: Existing pattern from commands.ts compactContext() and reviewContext()
 */
export function formatMessageForCompact(m: Message): string {
  // Assistant with tool_calls
  if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls) {
    const calls = m.tool_calls.map(tc =>
      `  → ${tc.function.name}(${truncate(tc.function.arguments, 200)})`
    ).join('\n');
    let out = `ASSISTANT (tool calls):\n${calls}`;
    if (m.reasoning_content) {
      out += `\n[thinking: ${truncate(m.reasoning_content, 300)}]`;
    }
    return out;
  }

  // Tool result
  if (m.role === 'tool') {
    const idShort = 'tool_call_id' in m ? m.tool_call_id.slice(0, 8) : '?';
    return `TOOL RESULT [${idShort}]: ${truncate(String(m.content), 500)}`;
  }

  // Regular text message (system / user / assistant)
  const content = 'content' in m && m.content ? String(m.content) : '';
  let out = `${m.role.toUpperCase()}: ${truncate(content, 1500)}`;
  if ('reasoning_content' in m && m.reasoning_content) {
    out += `\n[thinking: ${truncate(String(m.reasoning_content), 300)}]`;
  }
  return out;
}

// ── Token estimation (standalone, mirrors ContextManager.estimateTokens) ────

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if ('content' in msg && msg.content) {
      total += Math.ceil(String(msg.content).length / CHARS_PER_TOKEN);
    }
    if ('reasoning_content' in msg && msg.reasoning_content) {
      total += Math.ceil(String(msg.reasoning_content).length / CHARS_PER_TOKEN);
    }
    if ('tool_calls' in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += Math.ceil(tc.function.name.length / CHARS_PER_TOKEN);
        total += Math.ceil(tc.function.arguments.length / CHARS_PER_TOKEN);
      }
    }
  }
  return total;
}

// ── LLM summarization helper ────────────────────────────────────────────────

function buildCompactRequest(
  conversationText: string,
  isReasoner: boolean,
  lang: 'zh' | 'en',
  instruction: string,
): Message[] {
  if (isReasoner) {
    // R1 reasoner models don't support system role — embed in first user msg.
    // Ref: prepare-context.ts L103-105
    return [{
      role: 'user',
      content: `[System Instructions]\n${instruction}\n\n---\n\n${conversationText}`,
    }];
  }
  return [
    { role: 'system', content: instruction },
    { role: 'user', content: conversationText },
  ];
}

async function streamSummary(
  provider: LLMProvider,
  model: string,
  isReasoner: boolean,
  messages: Message[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  // Dot-progress indicator — streamSummary can be called from compactMessages
  // which may run 1-3+ LLM calls for chunking + merging. Gives user visible
  // feedback without interfering with concurrent spinners in commands.ts.
  const dotInterval = setInterval(() => {
    process.stdout.write(chalk.gray('.'));
  }, 1000);

  let summary = '';
  try {
    const stream = provider.stream(messages, {
      model,
      maxTokens,
      // Reasoner models don't support temperature — omit it.
      ...(isReasoner ? {} : { temperature: 0.2 }),
      signal,
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') summary += chunk.text;
    }
    return summary.trim();
  } finally {
    clearInterval(dotInterval);
  }
}

// ── Chunking ─────────────────────────────────────────────────────────────────

interface ChunkOptions {
  keepRecent: number;
  chunkTokens: number;
  language: 'zh' | 'en';
}

/**
 * Split messages into chunks for summarization.
 * Returns { toSummarize: Message[][] , recent: Message[] }
 * - `toSummarize`: groups of messages to summarize independently
 * - `recent`: last N messages kept intact (not summarized)
 */
export function chunkMessages(messages: Message[], opts: ChunkOptions): {
  toSummarize: Message[][];
  recent: Message[];
} {
  if (messages.length <= opts.keepRecent) {
    return { toSummarize: [], recent: messages };
  }

  const recent = messages.slice(-opts.keepRecent);
  const rest = messages.slice(0, messages.length - opts.keepRecent);

  const chunks: Message[][] = [];
  let currentChunk: Message[] = [];
  let currentTokens = 0;

  for (const msg of rest) {
    const msgTokens = estimateTokens([msg]);
    if (currentTokens + msgTokens > opts.chunkTokens && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
    currentChunk.push(msg);
    currentTokens += msgTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return { toSummarize: chunks, recent };
}

// ── Prompt builders ─────────────────────────────────────────────────────────

function chunkSummaryInstruction(lang: 'zh' | 'en'): string {
  return lang === 'zh'
    ? `你是一个对话摘要助手。请用中文简洁地总结以下对话片段，保留关键决策、代码变更和后续工作所需的重要上下文。只输出摘要，不要加前言。`
    : `You are a conversation summarizer. Concisely summarize the following conversation fragment, preserving key decisions, code changes, and important context needed to continue the work. Output only the summary, no preamble.`;
}

function mergeSummaryInstruction(lang: 'zh' | 'en'): string {
  return lang === 'zh'
    ? `你是一个对话摘要助手。以下是一段较长对话的分段摘要。请将它们合并为一个连贯、简洁的最终摘要。保留关键决策、代码变更和重要上下文。只输出摘要，不要加前言。`
    : `You are a conversation summarizer. Below are chunk summaries from a longer conversation. Merge them into one coherent, concise final summary. Preserve key decisions, code changes, and important context. Output only the summary, no preamble.`;
}

function singleSummaryInstruction(lang: 'zh' | 'en'): string {
  return lang === 'zh'
    ? `你是一个对话摘要助手。请用中文简洁地总结以下对话，保留关键决策、代码变更和后续工作所需的重要上下文。只输出摘要，不要加前言。`
    : `You are a conversation summarizer. Concisely summarize the following conversation, preserving key decisions, code changes made, and any important context needed to continue the work. Output only the summary, no preamble.`;
}

// ── Main entry point ────────────────────────────────────────────────────────

export interface CompactOptions {
  provider: LLMProvider;
  model: string;
  isReasoner: boolean;
  language: 'zh' | 'en';
  signal?: AbortSignal;
  /** Recent messages to keep uncompressed (default: 6) */
  keepRecent?: number;
  /** Max estimated tokens per chunk (default: 6000) */
  chunkTokens?: number;
}

export interface CompactResult {
  summary: string;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * Summarize conversation messages with hierarchical chunking.
 *
 * Flow:
 *   1. If too few messages → return early with null-like indication
 *   2. Split: keep recent messages, chunk the rest
 *   3. Summarize each chunk individually
 *   4. If multiple chunks → merge summaries into final
 *   5. Return final summary + token stats
 */
export async function compactMessages(
  allMessages: Message[],
  opts: CompactOptions,
): Promise<CompactResult | null> {
  const nonSystem = allMessages.filter(m => m.role !== 'system');
  if (nonSystem.length < MIN_MESSAGES) {
    return null; // nothing to compact
  }

  const keepRecent = opts.keepRecent ?? KEEP_RECENT;
  const chunkTokens = opts.chunkTokens ?? CHUNK_TOKENS;
  const lang = opts.language;

  const { toSummarize, recent } = chunkMessages(nonSystem, {
    keepRecent,
    chunkTokens,
    language: lang,
  });

  const beforeTokens = estimateTokens(nonSystem);

  let finalSummary: string;

  if (toSummarize.length === 0) {
    // Everything is "recent" — nothing to summarize
    return null;
  }

  if (toSummarize.length === 1) {
    // Single chunk — one LLM call
    const text = toSummarize[0].map(formatMessageForCompact).join('\n\n');
    const msgs = buildCompactRequest(text, opts.isReasoner, lang, singleSummaryInstruction(lang));
    finalSummary = await streamSummary(opts.provider, opts.model, opts.isReasoner, msgs, FINAL_SUMMARY_TOKENS, opts.signal);
  } else {
    // Multiple chunks — summarize each, then merge
    const chunkSummaries: string[] = [];
    for (let i = 0; i < toSummarize.length; i++) {
      const text = toSummarize[i].map(formatMessageForCompact).join('\n\n');
      const msgs = buildCompactRequest(text, opts.isReasoner, lang, chunkSummaryInstruction(lang));
      const summary = await streamSummary(opts.provider, opts.model, opts.isReasoner, msgs, CHUNK_SUMMARY_TOKENS, opts.signal);
      chunkSummaries.push(summary);
    }

    // Merge chunk summaries
    const mergeText = chunkSummaries
      .map((s, i) => `[Part ${i + 1}]\n${s}`)
      .join('\n\n');
    const mergeMsgs = buildCompactRequest(mergeText, opts.isReasoner, lang, mergeSummaryInstruction(lang));
    finalSummary = await streamSummary(opts.provider, opts.model, opts.isReasoner, mergeMsgs, FINAL_SUMMARY_TOKENS, opts.signal);
  }

  // Also include the recent messages' content in the summary context
  if (recent.length > 0) {
    const recentText = recent.map(formatMessageForCompact).join('\n\n');
    finalSummary = finalSummary + '\n\n[Recent context (kept intact)]\n' + truncate(recentText, 2000);
  }

  // Estimate after tokens (system + summary user + assistant ack)
  const afterTokens = Math.ceil(finalSummary.length / CHARS_PER_TOKEN)
    + Math.ceil(50 / CHARS_PER_TOKEN)  // assistant ack
    + (allMessages[0]?.role === 'system'
      ? Math.ceil(String(allMessages[0].content).length / CHARS_PER_TOKEN)
      : 0);

  return { summary: finalSummary, beforeTokens, afterTokens };
}
