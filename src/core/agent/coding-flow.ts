// ── Coding Flow (P/G/E) ─────────────────────────────────────────────────
// Extracted from loop.ts — Planner → Generator → Evaluator for code tasks.
//
// Ref: pipeline/types.ts for TaskPlan, EvaluationResult, IntentResult
// Ref: planner.ts, evaluator.ts for P/E implementations

import type { AgentRunOptions } from '../../types.js';
import chalk from 'chalk';
import ora from 'ora';
import { ContextManager } from '../context/manager.js';
import { confirmYesNo } from '../../utils/confirm.js';
import { getDefaultEventBus } from '../events/bus.js';
import { getDefaultMetrics } from '../observability/metrics.js';
import { getLogger } from '../observability/logger.js';
import {
  printPlanHeader, printStepProgress, printEvaluation, printRefineIndicator,
  printPlanTree, type PlanStepStatus,
} from '../../utils/display.js';
import { generatePlan } from './planner.js';
import { evaluateStep } from './evaluator.js';
import type { TaskPlan, EvaluationResult, IntentResult } from '../pipeline/types.js';
import { MAX_ITERATIONS, MAX_REFINE_RETRIES, displayToolCalls, runGenerator } from './generator.js';
import { PrepareContextStage } from '../pipeline/stages/prepare-context.js';

const log = getLogger('agent:coding-flow');

// ── Prune refine feedback messages from context ─────────────────────────

export function pruneRefineMessages(context: ContextManager): void {
  const filtered = context.getMessages().filter(m => {
    if (m.role !== 'user') return true;
    const text = typeof m.content === 'string' ? m.content : '';
    return !text.startsWith('[评估反馈]') && !text.startsWith('[Evaluation Feedback]');
  });
  context.setMessages(filtered);
}

// ── Coding flow: Planner → Generator → Evaluator ────────────────────────

export async function runCodingFlow(
  options: AgentRunOptions,
  context: ContextManager,
  lang: 'zh' | 'en',
  intent: IntentResult,
  metrics: ReturnType<typeof getDefaultMetrics>,
  _bus: ReturnType<typeof getDefaultEventBus>,
): Promise<{ responseLength: number }> {
  const { task, provider, onText, onToolCall, onToolResult, signal } = options;
  const model = options.config.model;

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 1: PLANNER
  // ══════════════════════════════════════════════════════════════════════

  log.info('Phase 1: Planner — analyzing task');
  const planSpinner = ora({ text: chalk.gray('Planning...'), color: 'gray', stream: process.stdout }).start();

  let plan: TaskPlan;
  // Skip planner for short tasks or continuation signals — the task itself
  // is the step. Only use the generic "continue" description when the task is
  // a bare continuation word (e.g. "继续", "go on") with no real content.
  const BARE_CONTINUATION = /^(继续|继续执行|继续吧|go\s*(on|ahead)?|continue|proceed|keep\s*going|next|下一步|执行|run\s*it|do\s*it)[\s!！。.]*$/i;
  const isContinuation = BARE_CONTINUATION.test(task.trim());
  if (isContinuation || task.trim().length <= 50) {
    planSpinner.stop();
    const stepDescription = isContinuation
      ? (lang === 'zh' ? '继续执行上一个任务，完成剩余步骤' : 'Continue the previous task and complete remaining steps')
      : task;
    log.info('Planner skipped', { taskLength: task.trim().length, isContinuation });
    plan = {
      goal: stepDescription,
      reasoning: isContinuation ? 'Continuation — skipping planner.' : 'Short task — skipping planner.',
      steps: [{ id: 1, description: stepDescription, toolsHint: [], expectedOutcome: 'Task completed', verification: 'No errors' }],
    };
  } else {
    try {
      plan = await generatePlan(provider, model, task, lang, signal);
      planSpinner.stop();
    } catch (err) {
      planSpinner.stop();
      log.warn('Planner failed, falling back to single-step execution', {
        error: err instanceof Error ? err.message : String(err),
      });
      plan = {
        goal: task.slice(0, 100),
        reasoning: 'Planner error — executing as single step.',
        steps: [{
          id: 1,
          description: task,
          toolsHint: [],
          expectedOutcome: 'Task completed',
          verification: 'No errors',
        }],
      };
    }
  }

  printPlanHeader(plan);

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 2: Step-by-step GENERATOR + EVALUATOR
  // ══════════════════════════════════════════════════════════════════════

  let finalAssistantText = '';
  let userRejected = false;
  let sessionHasRead = false;
  // Per-step status for the /plan tree visualization (v0.8) — redrawn on
  // every step transition so CODEGRUNT_VERBOSE users see live √/×/→ markers.
  const stepStatuses: PlanStepStatus[] = plan.steps.map(() => 'pending');
  // One PrepareContextStage instance shared across all steps/retries so system
  // prompt is only loaded once and the cache-stability guard works correctly.
  const prepareStage = new PrepareContextStage();
  // Global iteration counter — ensures iteration=0 only on the very first call.
  let globalIter = 0;

  // pruneRefineMessages is only called on the "evaluation passed" and "max
  // retries exhausted, user continued" paths below. If a step exits via
  // userRejected=true or a thrown generator error mid-retry, those calls are
  // skipped and any "[评估反馈]"/"[Evaluation Feedback]" messages already
  // pushed to context stay there permanently, polluting every future turn.
  // The try/finally guarantees cleanup on every exit path — the function is
  // idempotent (filters by prefix) so calling it again on the normal paths
  // is harmless.
  try {
  for (let stepIdx = 0; stepIdx < plan.steps.length; stepIdx++) {
    if (signal?.aborted) break;

    const step = plan.steps[stepIdx];
    printStepProgress(stepIdx, plan.steps.length, step.description);
    stepStatuses[stepIdx] = 'in_progress';
    printPlanTree(plan, stepStatuses);

    let stepPassed = false;
    let lastEval: EvaluationResult | null = null;

    for (let refineCount = 0; refineCount <= MAX_REFINE_RETRIES; refineCount++) {
      if (signal?.aborted) break;

      // Retry stepDesc is intentionally lean — the full [评估反馈]/[Evaluation Feedback]
      // message was already pushed to context by the refiner below. Repeating it
      // here would waste tokens and confuse the model.
      const stepDesc = refineCount === 0
        ? `Step ${step.id}/${plan.steps.length}: ${step.description}\nExpected: ${step.expectedOutcome}`
        : `RETRY Step ${step.id}: ${step.description}\nFix the issues from the evaluation feedback above and re-execute.`;

      let genResult = await runGenerator(
        context, options, lang, globalIter++, stepDesc, sessionHasRead, prepareStage,
      );

      if (genResult.hasReadThisTurn) sessionHasRead = true;
      if (genResult.userRejected) { userRejected = true; break; }
      // For generator errors (network glitches, transient API failures), retry once
      // instead of crashing the entire task. If both attempts fail, then throw.
      if (genResult.error) {
        if (refineCount < MAX_REFINE_RETRIES) {
          log.warn('Generator transient error, will retry', { error: genResult.error.message, refineCount });
          // Don't push an evaluation feedback message — let the outer refine loop
          // handle it naturally via stepDesc on the next iteration.
          continue;
        }
        log.error('Generator error after retries', { error: genResult.error.message });
        throw genResult.error;
      }
      displayToolCalls(genResult.pipeCtx, onToolCall, onToolResult);

      // Track tool message count BEFORE runGenerator so we only evaluate FRESH results.
      // Old tool results from previous retry attempts (stored in context) must NOT leak
      // into the evaluator, otherwise a single error causes infinite retries.
      // Using context.getMessages() ensures accuracy regardless of genResult state.
      const toolMsgCountBefore = context.getMessages().filter(
        m => m.role === 'tool' && 'tool_call_id' in m
      ).length;

      // Accumulate tool calls for this turn
      const allToolCalls: Array<{ name: string; args: string; id: string }> = [
        ...genResult.pipeCtx.toolCalls.map(tc => ({ name: tc.function.name, args: tc.function.arguments, id: tc.id })),
      ];

      {
        let innerIter = 1;
        while (!genResult.done && genResult.pipeCtx.toolCalls.length > 0 && innerIter < MAX_ITERATIONS) {
          if (signal?.aborted) break;

          const next = await runGenerator(
            context, options, lang, globalIter++, stepDesc, sessionHasRead, prepareStage, true,
          );
          if (next.hasReadThisTurn) sessionHasRead = true;
          if (next.userRejected) { userRejected = true; break; }
          if (next.error) throw next.error;
          displayToolCalls(next.pipeCtx, onToolCall, onToolResult);

          // Only accumulate NEW tool calls from this inner iteration
          for (const tc of next.pipeCtx.toolCalls) {
            allToolCalls.push({ name: tc.function.name, args: tc.function.arguments, id: tc.id });
          }

          genResult = next;
          innerIter++;
        }
        if (userRejected) break;
      }

      // Build evaluator inputs from the cumulative tool calls — but ONLY fresh tool results.
      // Slice by position WITHIN the tool-message-only list, not by index in the
      // full (mixed-role) messages array — those two counters have different units.
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
        sessionHasRead,
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
        stepStatuses[stepIdx] = 'done';
        printPlanTree(plan, stepStatuses);
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
          ? `步骤 ${step.id}/${plan.steps.length} 重试次数耗尽`
          : `Step ${step.id}/${plan.steps.length} failed after ${MAX_REFINE_RETRIES} retries`;
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
          stepStatuses[stepIdx] = 'done';
          printPlanTree(plan, stepStatuses);
        } else {
          userRejected = true;
          stepStatuses[stepIdx] = 'failed';
          printPlanTree(plan, stepStatuses);
          break;
        }
      }
    }

    if (userRejected) break;
    if (!stepPassed) {
      log.error('Step failed after all retries', { stepId: step.id });
      stepStatuses[stepIdx] = 'failed';
      printPlanTree(plan, stepStatuses);
    }
  }
  } finally {
    // Idempotent — no-op if the normal-path calls already pruned these messages.
    pruneRefineMessages(context);
  }

  if (userRejected) { log.info('Agent ended — user rejected'); return { responseLength: 0 }; }

  if (finalAssistantText) {
    process.stdout.write('\n');
  } else {
    const summaryMsg = lang === 'zh'
      ? '所有步骤已执行完成。请查看上述工具输出确认结果。'
      : 'All steps executed. Review the tool outputs above for results.';
    process.stdout.write(chalk.green('\n' + summaryMsg + '\n'));
  }

  log.info('Coding flow complete', { planSteps: plan.steps.length });
  metrics.increment('agent.coding_turns');
  return { responseLength: finalAssistantText.length };
}
