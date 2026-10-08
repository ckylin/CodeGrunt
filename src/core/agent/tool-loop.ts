// ── Iterative tool loop ─────────────────────────────────────────────────────
// Shared by the chat and skill flows: run the generator, then keep calling it
// while the model asks for tools, up to MAX_ITERATIONS.

import type { AgentRunOptions } from '../../types.js';
import type { ContextManager } from '../context/manager.js';
import type { PrepareContextStage } from '../pipeline/stages/prepare-context.js';
import { MAX_ITERATIONS, displayToolCalls, runGenerator, type GeneratorResult } from './generator.js';

export interface ToolLoopResult {
  /** The last generator result (the final answer, or the turn that stopped the loop). */
  last: GeneratorResult;
  iterations: number;
  /** The very first generation was rejected by the user; nothing else ran. */
  rejectedAtStart: boolean;
}

export async function runToolLoop(
  context: ContextManager,
  options: AgentRunOptions,
  lang: 'zh' | 'en',
  prepareStage: PrepareContextStage,
): Promise<ToolLoopResult> {
  const { onToolCall, onToolResult, signal } = options;

  const first = await runGenerator(context, options, lang, 0, undefined, false, prepareStage);
  if (first.userRejected) return { last: first, iterations: 0, rejectedAtStart: true };
  if (first.error) throw first.error;

  displayToolCalls(first.pipeCtx, onToolCall, onToolResult);

  let iteration = 1;
  let current = first;
  while (!current.done && current.pipeCtx.toolCalls.length > 0 && iteration < MAX_ITERATIONS) {
    if (signal?.aborted) break;
    current = await runGenerator(context, options, lang, iteration, undefined, false, prepareStage);
    if (current.userRejected) break;
    if (current.error) throw current.error;
    displayToolCalls(current.pipeCtx, onToolCall, onToolResult);
    iteration++;
  }

  return { last: current, iterations: iteration, rejectedAtStart: false };
}
