// ── Skill Flow ───────────────────────────────────────────────────────────
// Extracted from loop.ts — apply skill system prompt + content, then run.
// Supports two modes:
//   - inline: runs in the main agent context (same as chat flow)
//   - subagent: runs isolated via runSubagent (no write/edit/shell tools)
//
// Ref: generator.ts for runGenerator, displayToolCalls, MAX_ITERATIONS
// Ref: subagent.ts for runSubagent

import type { AgentRunOptions } from '../../types.js';
import chalk from 'chalk';
import { ContextManager } from '../context/manager.js';
import { getDefaultMetrics } from '../observability/metrics.js';
import { getLogger } from '../observability/logger.js';
import type { IntentResult } from '../pipeline/types.js';
import { MAX_ITERATIONS, displayToolCalls, runGenerator } from './generator.js';
import { PrepareContextStage } from '../pipeline/stages/prepare-context.js';
import { runSubagent } from './subagent.js';

const log = getLogger('agent:skill-flow');

export async function runSkillFlow(
  options: AgentRunOptions,
  context: ContextManager,
  lang: 'zh' | 'en',
  skill: NonNullable<IntentResult['matchedSkill']>,
  metrics: ReturnType<typeof getDefaultMetrics>,
): Promise<{ responseLength: number }> {
  const { onToolCall, onToolResult, signal } = options;

  log.info('Skill flow', { skill: skill.name, mode: skill.mode ?? 'inline' });
  process.stdout.write(chalk.gray(`  skill: ${skill.name}\n`));

  const skillTask = `${skill.content}\n\n---\n${options.task}`;

  // Subagent-mode skills run in an isolated, read-only context (no write/edit/shell,
  // no shared conversation history) via the same loop agent_open uses. Useful for
  // research-style skills that shouldn't be able to mutate the workspace.
  if (skill.mode === 'subagent') {
    const result = await runSubagent({
      task: skillTask,
      cwd: options.cwd,
      provider: options.provider,
      model: options.config.model,
      systemOverride: skill.system,
      signal,
    });
    if (options.onText && result.output) options.onText(result.output);
    log.info('Skill flow complete (subagent)', { skill: skill.name, iterations: result.iterations, toolCallCount: result.toolCallCount });
    metrics.increment('agent.skill_turns');
    return { responseLength: result.output.length };
  }

  const skillOptions: AgentRunOptions = {
    ...options,
    task: skillTask,
    systemPromptOverride: skill.system,
  };

  const prepareStage = new PrepareContextStage();
  const genResult = await runGenerator(context, skillOptions, lang, 0, undefined, false, prepareStage);

  if (genResult.userRejected) { log.info('Skill flow ended — user rejected'); return { responseLength: 0 }; }
  if (genResult.error) throw genResult.error;

  displayToolCalls(genResult.pipeCtx, onToolCall, onToolResult);

  let iteration = 1;
  let current = genResult;
  while (!current.done && current.pipeCtx.toolCalls.length > 0 && iteration < MAX_ITERATIONS) {
    if (signal?.aborted) break;
    current = await runGenerator(context, skillOptions, lang, iteration, undefined, false, prepareStage);
    if (current.userRejected) break;
    if (current.error) throw current.error;
    displayToolCalls(current.pipeCtx, onToolCall, onToolResult);
    iteration++;
  }

  log.info('Skill flow complete', { skill: skill.name, iterations: iteration });
  metrics.increment('agent.skill_turns');
  return { responseLength: current.pipeCtx.assistantText.length };
}
