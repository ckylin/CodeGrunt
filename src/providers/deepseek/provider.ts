import type OpenAI from 'openai';
import type { LLMProvider, Message, RequestOptions, StreamChunk, ToolDefinition, TextMessage, ToolCallMessage } from '../../types.js';
import { createOpenAIClient } from './client.js';
import type { CodeGruntConfig } from '../../types.js';
import chalk from 'chalk';
import { addUsage, PRICING as CORE_PRICING, calculateCost } from '../../core/usage.js';
import { recordUsage } from '../../utils/billing.js';
import { ApiError, RetryableError, UserAbortError } from '../../core/errors.js';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT']);
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404]);
const BASE_DELAY_MS = 1000;
const MAX_RETRY_AFTER_MS = 60_000;

function getStatusCode(err: unknown): number | undefined {
  if (err != null && typeof err === 'object' && 'status' in err) {
    const s = (err as Record<string, unknown>).status;
    return typeof s === 'number' ? s : undefined;
  }
  return undefined;
}

function getErrorCode(err: unknown): string | undefined {
  if (err != null && typeof err === 'object' && 'code' in err) {
    const c = (err as Record<string, unknown>).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

function getRetryAfterMs(err: unknown): number | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  // OpenAI SDK surfaces response headers on the error object
  const headers = (err as Record<string, unknown>).headers as Record<string, string> | undefined;
  const value = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!value) return undefined;
  const seconds = parseFloat(value);
  return isNaN(seconds) ? undefined : Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** Wraps a raw OpenAI SDK error in one of our typed error classes so callers
 *  (CLI/repl top-level catches) can distinguish "the API rejected the
 *  request" from "the network is flaky" without re-inspecting HTTP status
 *  codes themselves. Preserves the original error as `.cause` for logging. */
function wrapProviderError(err: unknown, status: number | undefined): CodeGruntErrorLike {
  const message = err instanceof Error ? err.message : String(err);
  if (status !== undefined && NON_RETRYABLE_STATUS.has(status)) {
    return new ApiError(message, status, { cause: err instanceof Error ? err : undefined });
  }
  return new RetryableError(message, { cause: err instanceof Error ? err : undefined });
}

// Local alias — both ApiError and RetryableError satisfy this shape.
type CodeGruntErrorLike = ApiError | RetryableError;

// Exported for direct unit testing of retry/error-wrapping behavior without
// needing to mock the full OpenAI streaming client.
export async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new UserAbortError();

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const status = getStatusCode(err);
      const code = getErrorCode(err);

      // Non-retryable HTTP errors — fail immediately
      if (status !== undefined && NON_RETRYABLE_STATUS.has(status)) {
        throw wrapProviderError(err, status);
      }

      // Only retry known transient errors
      const isRetryable =
        (status !== undefined && RETRYABLE_STATUS.has(status)) ||
        (code !== undefined && RETRYABLE_CODES.has(code));

      if (!isRetryable || attempt === maxRetries) {
        throw wrapProviderError(err, status);
      }

      // Determine wait time: retry-after header wins over backoff
      const retryAfterMs = getRetryAfterMs(err);
      const backoffMs = BASE_DELAY_MS * Math.pow(2, attempt); // 1s, 2s, 4s
      const waitMs = retryAfterMs ?? backoffMs;
      const waitSec = Math.round(waitMs / 1000);
      const retryNum = attempt + 1;

      process.stderr.write(
        chalk.gray(`  [retrying API call, attempt ${retryNum}/${maxRetries}, waiting ${waitSec}s...]\n`),
      );

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new UserAbortError());
        }, { once: true });
      });
    }
  }

  throw wrapProviderError(lastError, getStatusCode(lastError));
}

export class DeepSeekProvider implements LLMProvider {
  readonly id = 'deepseek';
  private client: OpenAI;

  constructor(config: CodeGruntConfig) {
    this.client = createOpenAIClient(config);
  }

  async *stream(messages: Message[], options: RequestOptions): AsyncIterable<StreamChunk> {
    // Only the last assistant message gets reasoning_content sent back —
    // re-sending older chain-of-thought would double input token cost.
    const lastAssistantIdx = messages.reduce((last, m, i) =>
      m.role === 'assistant' ? i : last, -1);
    const openaiMessages = messages.map((m, i) =>
      toOpenAIMessage(m, i === lastAssistantIdx));
    const tools = options.tools?.map(toOpenAITool);

    const stream = await withRetry(() => this.client.chat.completions.create({
      model: options.model,
      max_tokens: options.maxTokens,
      // temperature is intentionally undefined for reasoner models
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      // DeepSeek-specific parameters
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options.frequencyPenalty !== undefined ? { frequency_penalty: options.frequencyPenalty } : {}),
      ...(options.presencePenalty !== undefined ? { presence_penalty: options.presencePenalty } : {}),
      // R1 reasoning effort: controls how long the model thinks
      ...(options.reasoningEffort !== undefined
        ? { reasoning_effort: options.reasoningEffort } as Record<string, unknown>
        : {}),
      // V4 thinking mode toggle — V4 models think by default; explicitly disable
      // for calls that want a fast, non-reasoning response (e.g. summarization).
      ...(options.thinking !== undefined
        ? { thinking: { type: options.thinking } } as Record<string, unknown>
        : {}),
      messages: openaiMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
      stream: true,
      stream_options: { include_usage: true },
    }, { signal: options.signal }), options.signal);

    for await (const chunk of stream) {
      const choice = chunk.choices[0];

      // Usage stats arrive in the final chunk (choices may be empty)
      if (chunk.usage) {
        printUsage(chunk.usage, options.model);
      }

      if (!choice) continue;

      const delta = choice.delta;

      if (delta.content) {
        yield { type: 'text_delta', text: delta.content };
      }

      // DeepSeek reasoning_content — chain of thought (V4 & R1 both emit this)
      const reasoning = (delta as unknown as Record<string, unknown>).reasoning_content as string | undefined;
      if (reasoning) {
        yield { type: 'reasoning_delta', text: reasoning };
      }

      // Stream tool_call deltas directly — accumulation is handled by StreamResponseStage.
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          yield {
            type: 'tool_call_delta',
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            arguments_delta: tc.function?.arguments ?? '',
          };
        }
      }

      if (choice.finish_reason) {
        yield {
          type: 'finish',
          finish_reason: choice.finish_reason as 'stop' | 'tool_calls' | 'length',
        };
      }
    }
  }
}

/** Serialize our internal Message to OpenAI-compatible format.
 *  Only includes reasoning_content when includeReasoning is true (last assistant message only). */
function toOpenAIMessage(msg: Message, includeReasoning = false): OpenAI.Chat.ChatCompletionMessageParam {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: msg.tool_call_id,
      content: msg.content,
    };
  }

  if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
    const tcMsg = msg as ToolCallMessage;
    return {
      role: 'assistant',
      content: null,
      tool_calls: tcMsg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
      // Only send reasoning_content back for the last assistant message
      ...(includeReasoning && tcMsg.reasoning_content ? { reasoning_content: tcMsg.reasoning_content } as Record<string, unknown> : {}),
    } as unknown as OpenAI.Chat.ChatCompletionMessageParam;
  }

  // Regular text message (system / user / assistant with content)
  const textMsg = msg as TextMessage;
  return {
    role: textMsg.role as 'system' | 'user' | 'assistant',
    content: textMsg.content,
    // Preserve reasoning_content in last assistant message only
    ...(includeReasoning && textMsg.role === 'assistant' && textMsg.reasoning_content
      ? { reasoning_content: textMsg.reasoning_content } as Record<string, unknown>
      : {}),
  } as OpenAI.Chat.ChatCompletionMessageParam;
}

function printUsage(usage: OpenAI.CompletionUsage, model: string): void {
  const cached = (usage as unknown as Record<string, unknown>)?.prompt_cache_hit_tokens as number | undefined;
  const miss   = (usage as unknown as Record<string, unknown>)?.prompt_cache_miss_tokens as number | undefined;

  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const cacheHits = cached ?? 0;

  // Look up pricing from the centralized single source of truth in core/usage.ts
  const p = CORE_PRICING[model] ?? CORE_PRICING['deepseek-v4-flash'];

  if (cached !== undefined && (process.env['DEBUG'] || process.env['CODEGRUNT_VERBOSE'])) {
    const total = inputTokens;
    const hitPct = total > 0 ? Math.round((cached / total) * 100) : 0;
    const hitColor = hitPct >= 50 ? chalk.green : hitPct > 0 ? chalk.yellow : chalk.gray;

    process.stderr.write(
      chalk.gray(`  tokens: prompt=${total} (`) +
      hitColor(`cache_hit=${cached} ${hitPct}%`) +
      chalk.gray(` miss=${miss ?? 0}) output=${outputTokens}\n`),
    );
  }

  // Calculate cost from centralized function
  const totalCost = calculateCost(p, inputTokens, outputTokens, cacheHits);

  // Session tracking (in-memory) — unified UsageStats now includes cost
  addUsage({
    inputTokens,
    outputTokens,
    cacheHitTokens: cacheHits,
    cacheMissTokens: miss ?? 0,
    cost: totalCost,
  });

  // Persist to local usage log (fire-and-forget — don't block the stream)
  recordUsage(inputTokens, outputTokens, cacheHits, totalCost).catch(() => {});
}

function toOpenAITool(def: ToolDefinition): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: def.function.name,
      description: def.function.description,
      parameters: def.function.parameters as OpenAI.FunctionParameters,
    },
  };
}
