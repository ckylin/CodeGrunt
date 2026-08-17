// ── Stage 4: Post Process (v0.6: +R1 Thought Harvesting) ──────────────────
// Handles the finalization of a turn:
// - Pushes final assistant text message to context if stop/length
// - Detects truncation warnings (finishReason === 'length')
// - Determines whether to continue looping or stop
// - v0.6: Scans reasoning_content for escaped tool calls (R1 Harvesting)

import type { Stage, StageResult, PipelineContext } from '../types.js';
import type { ToolCall } from '../../../types.js';
import { getLogger } from '../../observability/logger.js';
import { harvestToolCalls, deduplicateHarvested, filterNonEscaped } from '../../agent/r1-harvester.js';

const log = getLogger('stage:post-process');

export class PostProcessStage implements Stage {
  readonly name = 'post-process';

  async execute(ctx: PipelineContext): Promise<StageResult> {
    // ── R1 Thought Harvesting (v0.6) ──────────────────────────────────
    // Before determining the effective finish reason, scan the reasoning
    // content for tool calls that the model thought about but didn't emit
    // as formal tool_calls.
    if (ctx.reasoningText && ctx.toolCalls.length === 0 && ctx.assistantText.trim().length === 0) {
      const harvested = deduplicateHarvested(harvestToolCalls(ctx.reasoningText));
      if (harvested.length > 0) {
        const nonEscaped = filterNonEscaped(harvested, ctx.toolCalls.map(tc => ({
          name: tc.function.name,
          args: tc.function.arguments,
        })));

        if (nonEscaped.length > 0) {
          log.info('R1 Thought Harvesting: found escaped tool calls in reasoning', {
            count: nonEscaped.length,
            names: nonEscaped.map(h => h.name).join(', '),
          });

          // Convert harvested calls to formal ToolCall objects
          const harvestedToolCalls: ToolCall[] = nonEscaped.map((h, i) => ({
            id: `harvested_${Date.now()}_${i}`,
            type: 'function' as const,
            function: {
              name: h.name,
              arguments: JSON.stringify(h.args),
            },
          }));

          // Only use harvested calls if no formal tool calls were emitted
          ctx.toolCalls = harvestedToolCalls;
          ctx.finishReason = 'tool_calls';
        }
      }
    }

    // Guard: if no finish chunk arrived but we have text and no tool calls,
    // treat as 'stop' — some providers omit the finish event on short responses.
    const effectiveReason = ctx.finishReason
      ?? (ctx.toolCalls.length > 0 ? 'tool_calls' : 'stop');

    if (ctx.finishReason === null) {
      log.warn('No finish chunk received — inferred finish reason', { effectiveReason });
    }

    // ── Helper: push assistant text message (text-only turns) ────────────
    const pushAssistantMessage = () => {
      if (!ctx.assistantText) return;
      ctx.messages.push({
        role: 'assistant',
        content: ctx.assistantText,
        ...(ctx.reasoningText ? { reasoning_content: ctx.reasoningText } : {}),
      });
    };

    // ── Stop — model finished naturally ──────────────────────────────────
    if (effectiveReason === 'stop') {
      pushAssistantMessage();
      log.debug('Turn complete — stop', { finishReason: effectiveReason });
      return { continue: false, done: true };
    }

    // ── Length — truncated by token limit; save whatever we have ─────────
    if (effectiveReason === 'length') {
      pushAssistantMessage();
      log.warn('Response truncated by token limit', {
        savedTextLength: ctx.assistantText.length,
        toolCallsDropped: ctx.toolCalls.length,
      });
      return { continue: false, done: true };
    }

    // ── Tool calls — ProcessToolCallsStage handles the assistant message ──
    if (effectiveReason === 'tool_calls') {
      log.debug('Turn continues — tool calls pending', {
        count: ctx.toolCalls.length,
        hasText: ctx.assistantText.length > 0,
      });
      return { continue: true, done: false };
    }

    // ── Unknown — fallback; save text to avoid silent data loss ──────────
    log.warn('Unknown finish reason — saving text and stopping', {
      finishReason: effectiveReason,
      textLength: ctx.assistantText.length,
    });
    pushAssistantMessage();
    return { continue: false, done: true };
  }
}
