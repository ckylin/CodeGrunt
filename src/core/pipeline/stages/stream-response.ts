// ── Stage 2: Stream Response ───────────────────────────────────────────────
// Calls the LLM, accumulates deltas into PipelineContext fields.
// Decouples streaming from display via StreamEmitter.
//
// Ref: Original streaming logic extracted from src/core/agent/loop.ts
// (the for-await loop over provider.stream with accumulator maps).

import type { Stage, StageResult, PipelineContext, StreamEmitter } from '../types.js';
import { getLogger } from '../../observability/logger.js';
import { getDefaultEventBus, type LLMRequestEvent, type LLMUsageEvent } from '../../events/bus.js';
import { getDefaultMetrics } from '../../observability/metrics.js';
import { getLastCallUsage } from '../../usage.js';

const log = getLogger('stage:stream-response');

// ── No-op emitter (used when no custom emitter is provided) ───────────────

const noopEmitter: StreamEmitter = {
  onTextDelta: () => {},
  onReasoningDelta: () => {},
  onToolCallDelta: () => {},
  onFinish: () => {},
};

// ── Tool call accumulator ─────────────────────────────────────────────────

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

// ── Stage ──────────────────────────────────────────────────────────────────

export interface StreamResponseStageOptions {
  /** Optional emitter for streaming UI updates */
  emitter?: StreamEmitter;
}

export class StreamResponseStage implements Stage {
  readonly name = 'stream-response';

  constructor(private options: StreamResponseStageOptions = {}) {}

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const emitter = this.options.emitter ?? noopEmitter;
    const bus = getDefaultEventBus();
    const metrics = getDefaultMetrics();
    const startTime = Date.now();

    // Calculate estimated token count for event
    const estimatedTokens = ctx.messages.reduce((sum, m) => {
      if ('content' in m && m.content) sum += Math.ceil(String(m.content).length / 4);
      return sum;
    }, 0);

    bus.emit({
      type: 'llm:request',
      model: ctx.config.model,
      messageCount: ctx.messages.length,
      estimatedTokens,
      timestamp: startTime,
    } as LLMRequestEvent);

    // Reset per-turn accumulators
    ctx.assistantText = '';
    ctx.reasoningText = '';
    ctx.toolCalls = [];
    ctx.finishReason = null;
    ctx.outputTokens = 0;

    const accumulator = new Map<number, AccumulatedToolCall>();

    // Show a waiting indicator before the first chunk arrives — otherwise
    // non-reasoner models (no reasoning_delta) leave the terminal blank for
    // the entire API round-trip.
    emitter.startThinking?.();

    try {
      const stream = ctx.provider.stream(ctx.messages, {
        model: ctx.config.model,
        maxTokens: ctx.config.maxTokens,
        temperature: ctx.isReasoner ? undefined : ctx.config.temperature,
        reasoningEffort: ctx.isReasoner ? ctx.config.reasoningEffort : undefined,
        topP: ctx.config.topP,
        frequencyPenalty: ctx.config.frequencyPenalty,
        presencePenalty: ctx.config.presencePenalty,
        thinking: ctx.thinking,
        tools: ctx.toolDefinitions,
        signal: ctx.signal,
      });

      const streamTimer = metrics.startTimer('llm.stream');

      for await (const chunk of stream) {
        if (ctx.signal?.aborted) break;

        switch (chunk.type) {
          case 'text_delta': {
            ctx.assistantText += chunk.text;
            ctx.outputTokens += Math.ceil(chunk.text.length / 4);
            emitter.onTextDelta(chunk.text);
            break;
          }
          case 'reasoning_delta': {
            ctx.reasoningText += chunk.text;
            ctx.outputTokens += Math.ceil(chunk.text.length / 4);
            emitter.onReasoningDelta(chunk.text);
            break;
          }
          case 'tool_call_delta': {
            const existing = accumulator.get(chunk.index) ?? { id: '', name: '', arguments: '' };
            if (chunk.id) existing.id = chunk.id;
            if (chunk.name) existing.name = chunk.name;
            existing.arguments += chunk.arguments_delta;
            accumulator.set(chunk.index, existing);
            emitter.onToolCallDelta(chunk.index, chunk.id, chunk.name, chunk.arguments_delta);
            break;
          }
          case 'finish': {
            ctx.finishReason = chunk.finish_reason;
            emitter.onFinish(chunk.finish_reason);
            break;
          }
        }
      }

      streamTimer();

      // Convert accumulator to sorted tool calls
      ctx.toolCalls = Array.from(accumulator.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));

      const durationMs = Date.now() - startTime;
      metrics.increment('llm.requests');
      log.info('LLM stream completed', {
        model: ctx.config.model,
        outputTokens: ctx.outputTokens,
        toolCalls: ctx.toolCalls.length,
        finishReason: ctx.finishReason,
        durationMs,
      });

      // Detect reasoner model timing even if no reasoning content was emitted
      // (some reasoner models emit thinking without reasoning_content deltas)

    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'UserAbortError' || ctx.signal?.aborted) {
        log.info('LLM stream aborted');
        throw err;
      }
      log.error('LLM stream error', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }

    // Emit usage event — real cache hit/miss data comes from the provider's
    // per-call snapshot, updated by addUsage() during the stream's final chunk.
    const callUsage = getLastCallUsage();
    bus.emit({
      type: 'llm:usage',
      model: ctx.config.model,
      inputTokens: callUsage.inputTokens > 0 ? callUsage.inputTokens : estimatedTokens,
      outputTokens: callUsage.outputTokens > 0 ? callUsage.outputTokens : ctx.outputTokens,
      cacheHitTokens: callUsage.cacheHitTokens,
      cacheMissTokens: callUsage.cacheMissTokens,
      costUsd: 0,
      timestamp: Date.now(),
    } as LLMUsageEvent);

    return { continue: true, done: false };
  }
}
