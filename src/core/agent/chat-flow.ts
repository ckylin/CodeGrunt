// ── Chat Flow ───────────────────────────────────────────────────────────
// Extracted from loop.ts — direct generation, no Planner or Evaluator.
//
// Ref: generator.ts for runGenerator, displayToolCalls, MAX_ITERATIONS

import type { AgentRunOptions } from '../../types.js';
import chalk from 'chalk';
import { ContextManager } from '../context/manager.js';
import { getDefaultMetrics } from '../observability/metrics.js';
import { getLogger } from '../observability/logger.js';
import { runToolLoop } from './tool-loop.js';
import { PrepareContextStage } from '../pipeline/stages/prepare-context.js';
import { write as chWrite } from '../output/output-channel.js';

const log = getLogger('agent:chat-flow');

export async function runChatFlow(
  options: AgentRunOptions,
  context: ContextManager,
  lang: 'zh' | 'en',
  metrics: ReturnType<typeof getDefaultMetrics>,
): Promise<{ responseLength: number }> {
  log.info('Phase 1 (chat): direct generation — no Evaluator');

  const { last: current, iterations: iteration, rejectedAtStart } =
    await runToolLoop(context, options, lang, new PrepareContextStage());
  if (rejectedAtStart) { log.info('Chat flow ended — user rejected'); return { responseLength: 0 }; }

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
