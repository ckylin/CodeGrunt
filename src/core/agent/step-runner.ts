// ── Step Runner ─────────────────────────────────────────────────────────
// One plan step end to end: generator (with inner tool-call iteration) →
// evaluator → refine-retry loop. Shared by the sequential coding flow and the
// Orchestrator, which lives in its own module so neither imports the other.

import type { AgentRunOptions } from '../../types.js';
import type { ContextManager } from '../context/manager.js';
import { confirmYesNo } from '../../utils/confirm.js';
import { getLogger } from '../observability/logger.js';
import { printEvaluation, printRefineIndicator } from '../../utils/display.js';
import { evaluateStep } from './evaluator.js';
import type { TaskPlan, EvaluationResult } from '../pipeline/types.js';
import { MAX_ITERATIONS, MAX_REFINE_RETRIES, displayToolCalls, runGenerator } from './generator.js';
import { PrepareContextStage } from '../pipeline/stages/prepare-context.js';

const log = getLogger('agent:step-runner');

// ── Prune refine feedback messages from context ─────────────────────────

export function pruneRefineMessages(context: ContextManager): void {
  const filtered = context.getMessages().filter(m => {
    if (m.role !== 'user') return true;
    const text = typeof m.content === 'string' ? m.content : '';
    return !text.startsWith('[评估反馈]') && !text.startsWith('[Evaluation Feedback]');
  });
  context.setMessages(filtered);
}

// ── Shared per-step execution state ──────────────────────────────────────
// Threaded through runSingleStep() calls so sequential steps in the same
// flow share iteration counters, the read-tracking flag, and the single
// PrepareContextStage instance (system prompt loaded once per session).

export interface StepRunState {
  sessionHasRead: boolean;
  globalIter: number;
  prepareStage: PrepareContextStage;
}

export function createStepRunState(): StepRunState {
  return { sessionHasRead: false, globalIter: 0, prepareStage: new PrepareContextStage() };
}

export interface SingleStepResult {
  /** True if the step passed evaluation (or the user chose to continue past a failure). */
  stepPassed: boolean;
  /** True if the user rejected a tool confirmation or declined to continue past a failed step. */
  userRejected: boolean;
  /** Final assistant text produced on the step's last generator call. */
  finalAssistantText: string;
  lastEval: EvaluationResult | null;
}

/**
 * Run one plan step to completion: generator (with inner tool-call
 * iteration) → evaluator → refine-retry loop, up to MAX_REFINE_RETRIES.
 * Extracted from the step loop below so the Orchestrator (parallel batches)
 * can run the exact same per-step logic for steps executed sequentially,
 * without duplicating it.
 */
export async function runSingleStep(
  step: TaskPlan['steps'][number],
  totalSteps: number,
  context: ContextManager,
  options: AgentRunOptions,
  lang: 'zh' | 'en',
  state: StepRunState,
): Promise<SingleStepResult> {
  const { provider, onToolCall, onToolResult, signal } = options;
  const model = options.config.model;

  let stepPassed = false;
  let userRejected = false;
  let finalAssistantText = '';
  let lastEval: EvaluationResult | null = null;

  for (let refineCount = 0; refineCount <= MAX_REFINE_RETRIES; refineCount++) {
    if (signal?.aborted) break;

    const stepDesc = refineCount === 0
      ? `Step ${step.id}/${totalSteps}: ${step.description}\nExpected: ${step.expectedOutcome}`
      : `RETRY Step ${step.id}: ${step.description}\nFix the issues from the evaluation feedback above and re-execute.`;

    let genResult = await runGenerator(
      context, options, lang, state.globalIter++, stepDesc, state.sessionHasRead, state.prepareStage,
    );

    if (genResult.hasReadThisTurn) state.sessionHasRead = true;
    if (genResult.userRejected) { userRejected = true; break; }
    if (genResult.error) {
      if (refineCount < MAX_REFINE_RETRIES) {
        log.warn('Generator transient error, will retry', { error: genResult.error.message, refineCount });
        continue;
      }
      log.error('Generator error after retries', { error: genResult.error.message });
      throw genResult.error;
    }
    displayToolCalls(genResult.pipeCtx, onToolCall, onToolResult);

    const toolMsgCountBefore = context.getMessages().filter(
      m => m.role === 'tool' && 'tool_call_id' in m
    ).length;

    const allToolCalls: Array<{ name: string; args: string; id: string }> = [
      ...genResult.pipeCtx.toolCalls.map(tc => ({ name: tc.function.name, args: tc.function.arguments, id: tc.id })),
    ];

    {
      let innerIter = 1;
      while (!genResult.done && genResult.pipeCtx.toolCalls.length > 0 && innerIter < MAX_ITERATIONS) {
        if (signal?.aborted) break;

        const next = await runGenerator(
          context, options, lang, state.globalIter++, stepDesc, state.sessionHasRead, state.prepareStage, true,
        );
        if (next.hasReadThisTurn) state.sessionHasRead = true;
        if (next.userRejected) { userRejected = true; break; }
        if (next.error) throw next.error;
        displayToolCalls(next.pipeCtx, onToolCall, onToolResult);

        for (const tc of next.pipeCtx.toolCalls) {
          allToolCalls.push({ name: tc.function.name, args: tc.function.arguments, id: tc.id });
        }

        genResult = next;
        innerIter++;
      }
      if (userRejected) break;
    }

    const currentTurnToolCalls = allToolCalls.map(tc => ({ name: tc.name, args: tc.args }));
    const toolCallById = new Map(allToolCalls.map(tc => [tc.id, tc.name]));
    const freshToolMessages = genResult.pipeCtx.messages
      .filter(m => m.role === 'tool' && 'tool_call_id' in m)
      .slice(toolMsgCountBefore)
      .map(m => ({ content: String(m.content), tool_call_id: (m as import('../../types.js').ToolResultMessage).tool_call_id }));
    const currentTurnToolResults = freshToolMessages.map(m => ({
      content: m.content,
      toolName: toolCallById.get(m.tool_call_id),
    }));

    const evaluation = await evaluateStep(provider, model, {
      planStep: step,
      messages: genResult.pipeCtx.messages,
      assistantText: genResult.pipeCtx.assistantText,
      sessionHasRead: state.sessionHasRead,
      currentTurnToolCalls,
      currentTurnToolResults,
      language: lang,
      cwd: options.cwd,
      signal,
    });

    lastEval = evaluation;
    printEvaluation(evaluation, lang);

    if (evaluation.passed) {
      stepPassed = true;
      finalAssistantText = genResult.pipeCtx.assistantText;
      pruneRefineMessages(context);
      break;
    }

    if (refineCount < MAX_REFINE_RETRIES) {
      printRefineIndicator(refineCount + 1, MAX_REFINE_RETRIES, lang);
      const refineMsg = lang === 'zh'
        ? `[评估反馈] 上一步执行未通过质量检查。\n问题：\n${evaluation.issues.map(i => `- ${i}`).join('\n')}\n\n建议：\n${evaluation.suggestions.map(s => `- ${s}`).join('\n')}\n\n请修正上述问题并重新执行。`
        : `[Evaluation Feedback] Previous step did not pass quality check.\nIssues:\n${evaluation.issues.map(i => `- ${i}`).join('\n')}\n\nSuggestions:\n${evaluation.suggestions.map(s => `- ${s}`).join('\n')}\n\nPlease fix the issues and re-execute.`;
      context.push({ role: 'user', content: refineMsg });
      log.info('Refining step', { stepId: step.id, retry: refineCount + 1 });
    } else {
      log.warn('Max retries exhausted for step', { stepId: step.id });
      pruneRefineMessages(context);

      const issuesSummary = (lastEval?.issues ?? []).join(', ') || (lang === 'zh' ? '未知问题' : 'unknown issues');
      const stepLabel = lang === 'zh'
        ? `步骤 ${step.id}/${totalSteps} 重试次数耗尽`
        : `Step ${step.id}/${totalSteps} failed after ${MAX_REFINE_RETRIES} retries`;
      const promptText = lang === 'zh'
        ? `⚠  ${stepLabel}。\n问题：${issuesSummary}\n是否继续？[y/N]`
        : `⚠  ${stepLabel}.\nIssues: ${issuesSummary}\nContinue anyway? [y/N]`;

      const wantContinue = await confirmYesNo(promptText);
      if (wantContinue) {
        const warningMsg = lang === 'zh'
          ? `[警告：步骤 ${step.id} 可能未完成 — 用户选择继续]`
          : `[WARNING: step ${step.id} may be incomplete — continuing at user request]`;
        context.push({ role: 'user', content: warningMsg });
        stepPassed = true;
        finalAssistantText = genResult.pipeCtx.assistantText;
      } else {
        userRejected = true;
        break;
      }
    }
  }

  return { stepPassed, userRejected, finalAssistantText, lastEval };
}
