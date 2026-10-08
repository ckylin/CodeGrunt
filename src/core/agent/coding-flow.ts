// ── Coding Flow (P/G/E) ─────────────────────────────────────────────────
// Extracted from loop.ts — Planner → Generator → Evaluator for code tasks.
//
// Ref: pipeline/types.ts for TaskPlan, EvaluationResult, IntentResult
// Ref: planner.ts, evaluator.ts for P/E implementations

import type { AgentRunOptions } from '../../types.js';
import chalk from 'chalk';
import ora from 'ora';
import type { ContextManager } from '../context/manager.js';
import { getDefaultEventBus } from '../events/bus.js';
import { getDefaultMetrics } from '../observability/metrics.js';
import { getLogger } from '../observability/logger.js';
import {
  printPlanHeader, printStepProgress, printPlanTree, type PlanStepStatus,
} from '../../utils/display.js';
import { generatePlan } from './planner.js';
import type { TaskPlan, IntentResult } from '../pipeline/types.js';
import { write as chWrite, hasSink } from '../output/output-channel.js';
import { runOrchestrator } from './orchestrator.js';

const log = getLogger('agent:coding-flow');

export { pruneRefineMessages, createStepRunState, runSingleStep } from './step-runner.js';
export type { StepRunState, SingleStepResult } from './step-runner.js';
import { pruneRefineMessages, createStepRunState, runSingleStep } from './step-runner.js';

// ── Coding flow: Planner → Generator → Evaluator ────────────────────────

export async function runCodingFlow(
  options: AgentRunOptions,
  context: ContextManager,
  lang: 'zh' | 'en',
  intent: IntentResult,
  metrics: ReturnType<typeof getDefaultMetrics>,
  _bus: ReturnType<typeof getDefaultEventBus>,
): Promise<{ responseLength: number }> {
  const { task, provider, signal } = options;
  const model = options.config.model;

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 1: PLANNER
  // ══════════════════════════════════════════════════════════════════════

  log.info('Phase 1: Planner — analyzing task');
  // ora writes raw ANSI cursor-movement bytes straight to process.stdout —
  // safe only when nothing else owns the terminal's live region. Once a
  // persistent App is mounted (hasSink() true), Ink owns that region and a
  // second thing moving the cursor on its own would tear the frame. Skip
  // the spinner visual entirely in that mode; planning is fast enough that
  // silence here doesn't leave a dead-feeling gap (unlike the Thinking...
  // spinner in generator.ts, which covers a much longer LLM round-trip).
  const planSpinner = hasSink()
    ? { stop: () => {} }
    : ora({ text: chalk.gray('Planning...'), color: 'gray', stream: process.stdout }).start();

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

  // Plans with at least one parallelizable step are handed off to the
  // Orchestrator, which batches steps into serial/parallel groups and
  // dispatches parallel batches to worker.ts sub-agents. Plans with no
  // parallelizable steps (the vast majority — short tasks, single-step
  // plans, and any Planner output that didn't mark anything parallel) take
  // the original sequential path unchanged below, so existing behavior and
  // tests for the common case are unaffected.
  const hasParallelStep = plan.steps.some(s => s.parallelizable);

  if (hasParallelStep) {
    const orchResult = await runOrchestrator(plan, options, context, lang);
    finalAssistantText = orchResult.finalAssistantText;
    userRejected = orchResult.userRejected;

    if (userRejected) { log.info('Agent ended — user rejected'); return { responseLength: 0 }; }

    if (!finalAssistantText) {
      const summaryMsg = lang === 'zh'
        ? '所有步骤已执行完成。请查看上述工具输出确认结果。'
        : 'All steps executed. Review the tool outputs above for results.';
      chWrite(chalk.green('\n' + summaryMsg + '\n'));
    }

    log.info('Coding flow complete (orchestrated)', { planSteps: plan.steps.length });
    metrics.increment('agent.coding_turns');
    return { responseLength: finalAssistantText.length };
  }

  // Per-step status for the /plan tree visualization (v0.8) — redrawn on
  // every step transition so CODEGRUNT_VERBOSE users see live √/×/→ markers.
  const stepStatuses: PlanStepStatus[] = plan.steps.map(() => 'pending');
  // Shared across all steps/retries: iteration counter, read-tracking flag,
  // and the single PrepareContextStage instance (system prompt loaded once).
  const state = createStepRunState();

  // pruneRefineMessages is only called on the "evaluation passed" and "max
  // retries exhausted, user continued" paths inside runSingleStep(). If a step
  // exits via userRejected=true or a thrown generator error mid-retry, those
  // calls are skipped and any "[评估反馈]"/"[Evaluation Feedback]" messages
  // already pushed to context stay there permanently, polluting every future
  // turn. The try/finally guarantees cleanup on every exit path — the function
  // is idempotent (filters by prefix) so calling it again on the normal paths
  // is harmless.
  try {
  for (let stepIdx = 0; stepIdx < plan.steps.length; stepIdx++) {
    if (signal?.aborted) break;

    const step = plan.steps[stepIdx];
    printStepProgress(stepIdx, plan.steps.length, step.description);
    stepStatuses[stepIdx] = 'in_progress';
    printPlanTree(plan, stepStatuses);

    const result = await runSingleStep(step, plan.steps.length, context, options, lang, state);
    userRejected = result.userRejected;

    if (result.stepPassed) {
      finalAssistantText = result.finalAssistantText;
      stepStatuses[stepIdx] = 'done';
      printPlanTree(plan, stepStatuses);
    } else {
      stepStatuses[stepIdx] = 'failed';
      printPlanTree(plan, stepStatuses);
      if (!userRejected) log.error('Step failed after all retries', { stepId: step.id });
    }

    if (userRejected) break;
  }
  } finally {
    // Idempotent — no-op if the normal-path calls already pruned these messages.
    pruneRefineMessages(context);
  }

  if (userRejected) { log.info('Agent ended — user rejected'); return { responseLength: 0 }; }

  if (!finalAssistantText) {
    const summaryMsg = lang === 'zh'
      ? '所有步骤已执行完成。请查看上述工具输出确认结果。'
      : 'All steps executed. Review the tool outputs above for results.';
    chWrite(chalk.green('\n' + summaryMsg + '\n'));
  }

  log.info('Coding flow complete', { planSteps: plan.steps.length });
  metrics.increment('agent.coding_turns');
  return { responseLength: finalAssistantText.length };
}
