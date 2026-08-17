// ── Chat Flow ───────────────────────────────────────────────────────────
// Extracted from loop.ts — direct generation, no Planner or Evaluator.
//
// Ref: generator.ts for runGenerator, displayToolCalls, MAX_ITERATIONS

import type { AgentRunOptions } from '../../types.js';
import chalk from 'chalk';
import { ContextManager } from '../context/manager.js';
import { getDefaultMetrics } from '../observability/metrics.js';
import { getLogger } from '../observability/logger.js';
import { MAX_ITERATIONS, displayToolCalls, runGenerator } from './generator.js';
import { PrepareContextStage } from '../pipeline/stages/prepare-context.js';
import { write as chWrite } from '../../cli/ink/output-channel.js';

const log = getLogger('agent:chat-flow');

export async function runChatFlow(
  options: AgentRunOptions,
  context: ContextManager,
  lang: 'zh' | 'en',
  metrics: ReturnType<typeof getDefaultMetrics>,
): Promise<{ responseLength: number }> {
  const { task, onToolCall, onToolResult, signal } = options;

  log.info('Phase 1 (chat): direct generation — no Evaluator');

  const prepareStage = new PrepareContextStage();
  const genResult = await runGenerator(context, options, lang, 0, undefined, false, prepareStage);

  if (genResult.userRejected) { log.info('Chat flow ended — user rejected'); return { responseLength: 0 }; }
  if (genResult.error) throw genResult.error;

  displayToolCalls(genResult.pipeCtx, onToolCall, onToolResult);

  let iteration = 1;
  let current = genResult;
  while (!current.done && current.pipeCtx.toolCalls.length > 0 && iteration < MAX_ITERATIONS) {
    if (signal?.aborted) break;
    current = await runGenerator(context, options, lang, iteration, undefined, false, prepareStage);
    if (current.userRejected) break;
    if (current.error) throw current.error;
    displayToolCalls(current.pipeCtx, onToolCall, onToolResult);
    iteration++;
  }

  const finalText = current.pipeCtx.assistantText;
  if (!finalText && current.pipeCtx.toolCalls.length === 0) {
    const fallback = lang === 'zh'
      ? chalk.gray('  (模型未返回文本响应)\n')
      : chalk.gray('  (no text response from model)\n');
    chWrite(fallback);
  }

  log.info('Chat flow complete', { iterations: iteration });
  metrics.increment('agent.chat_turns');
  return { responseLength: current.pipeCtx.assistantText.length };
}
