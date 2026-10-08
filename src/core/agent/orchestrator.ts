// ── Orchestrator: batches plan steps into serial/parallel groups ───────────
// Sits between the Planner and the per-step execution logic. Groups
// consecutive `parallelizable: true` steps (with non-overlapping
// `targetFiles`) into a single batch dispatched concurrently to
// worker.ts sub-agents; everything else runs sequentially through the
// existing runSingleStep() (same generator+evaluator+refine loop as before).
//
// Only invoked by coding-flow.ts when at least one step in the plan is
// marked parallelizable — plans with no parallel steps never touch this
// file, so the original sequential behavior is completely unchanged for
// the common case.

import type { AgentRunOptions } from '../../types.js';
import chalk from 'chalk';
import { ContextManager } from '../context/manager.js';
import { getDefaultEventBus, type OrchestratorBatchEvent } from '../events/bus.js';
import { getLogger } from '../observability/logger.js';
import { printPlanTree, type PlanStepStatus } from '../../utils/display.js';
import { write as chWrite } from '../output/output-channel.js';
import type { TaskPlan, PlanStep } from '../pipeline/types.js';
import { runSingleStep, createStepRunState, type StepRunState } from './step-runner.js';
import { runSubagentsConcurrent, getSubagentContext } from './subagent.js';
import { getWorkerWriteToolNames, getWriterAllowlist } from './worker.js';

const log = getLogger('agent:orchestrator');

export interface OrchestratorResult {
  finalAssistantText: string;
  userRejected: boolean;
  stepStatuses: PlanStepStatus[];
}

// ── Batch grouping ─────────────────────────────────────────────────────────

interface Batch {
  steps: PlanStep[];
  mode: 'parallel' | 'serial';
}

/**
 * Group consecutive parallelizable steps into a single parallel batch.
 * A parallelizable step is demoted to serial (its own single-step batch) if
 * its targetFiles overlap with another parallelizable step earlier in the
 * same run of consecutive parallelizable steps — this avoids two workers
 * racing to write the same file.
 */
export function groupIntoBatches(steps: PlanStep[]): Batch[] {
  const batches: Batch[] = [];
  let i = 0;

  while (i < steps.length) {
    const step = steps[i];
    if (!step.parallelizable) {
      batches.push({ steps: [step], mode: 'serial' });
      i++;
      continue;
    }

    // Collect the run of consecutive parallelizable steps.
    const run: PlanStep[] = [];
    let j = i;
    while (j < steps.length && steps[j].parallelizable) {
      run.push(steps[j]);
      j++;
    }

    // Detect targetFiles overlaps within the run; overlapping steps (or
    // steps with no declared targetFiles, which we can't prove are safe)
    // are demoted to their own serial batch. Ordering: the whole parallel
    // group runs first (as one batch), then every demoted step runs
    // serially afterward, in original plan order — demoted steps are never
    // interleaved back into their original mid-run position, since doing
    // so would fragment the parallel group into smaller batches and lose
    // most of the concurrency benefit.
    const seenFiles = new Set<string>();
    const parallelGroup: PlanStep[] = [];
    const demoted: PlanStep[] = [];
    for (const s of run) {
      const files = s.targetFiles ?? [];
      const hasOverlap = files.length > 0 && files.some(f => seenFiles.has(f));
      if (hasOverlap || files.length === 0) {
        demoted.push(s);
      } else {
        for (const f of files) seenFiles.add(f);
        parallelGroup.push(s);
      }
    }

    if (parallelGroup.length > 1) {
      batches.push({ steps: parallelGroup, mode: 'parallel' });
      for (const s of demoted) batches.push({ steps: [s], mode: 'serial' });
    } else {
      // Fewer than 2 parallel-safe steps — no point spawning workers for a
      // single-step "batch". Run every step in the run serially, in order.
      for (const s of run) batches.push({ steps: [s], mode: 'serial' });
    }

    i = j;
  }

  return batches;
}

// ── Parallel batch execution ────────────────────────────────────────────

async function runParallelBatch(
  batch: Batch,
  totalSteps: number,
  options: AgentRunOptions,
  lang: 'zh' | 'en',
): Promise<Map<number, { success: boolean; output: string; error?: string }>> {
  const ctx = getSubagentContext();
  const results = new Map<number, { success: boolean; output: string; error?: string }>();

  if (!ctx) {
    // Should not happen — setSubagentContext() is called once per turn in loop.ts
    // before any flow runs. Fail safe: mark every step as failed so the caller
    // falls back to serial retry rather than silently dropping work.
    for (const step of batch.steps) {
      results.set(step.id, { success: false, output: '', error: 'orchestrator: no subagent context available' });
    }
    return results;
  }

  const writeTools = getWorkerWriteToolNames();
  const tasks = batch.steps.map(step => {
    const hasWrite = step.toolsHint.some(h => writeTools.has(h))
      || /write|edit|create|modify|update/i.test(step.description);
    return {
      task: `## Step ${step.id}/${totalSteps} (parallel)\n${step.description}\nExpected: ${step.expectedOutcome}\nTarget files: ${(step.targetFiles ?? []).join(', ') || '(none declared)'}`,
      cwd: options.cwd,
      provider: ctx.provider,
      model: ctx.model,
      _allowedTools: hasWrite ? getWriterAllowlist() : undefined,
    };
  });

  const concurrentResult = await runSubagentsConcurrent({
    tasks,
    allowPartialFailure: true,
    signal: options.signal,
  });

  batch.steps.forEach((step, idx) => {
    const r = concurrentResult.results[idx];
    results.set(step.id, { success: r?.success ?? false, output: r?.output ?? '', error: r?.error });
  });

  return results;
}

// ── Main orchestration ──────────────────────────────────────────────────

export async function runOrchestrator(
  plan: TaskPlan,
  options: AgentRunOptions,
  context: ContextManager,
  lang: 'zh' | 'en',
): Promise<OrchestratorResult> {
  const { signal } = options;
  const bus = getDefaultEventBus();
  const stepStatuses: PlanStepStatus[] = plan.steps.map(() => 'pending');
  const state: StepRunState = createStepRunState();

  let finalAssistantText = '';
  let userRejected = false;

  const batches = groupIntoBatches(plan.steps);
  log.info('Orchestrator grouped plan into batches', {
    batchCount: batches.length,
    parallelBatches: batches.filter(b => b.mode === 'parallel').length,
  });

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    if (signal?.aborted || userRejected) break;
    const batch = batches[batchIdx];
    const batchStart = Date.now();

    for (const s of batch.steps) {
      const idx = plan.steps.indexOf(s);
      if (idx >= 0) stepStatuses[idx] = 'in_progress';
    }
    printPlanTree(plan, stepStatuses);

    const succeededStepIds: number[] = [];
    const failedStepIds: number[] = [];

    if (batch.mode === 'serial') {
      const step = batch.steps[0];
      const result = await runSingleStep(step, plan.steps.length, context, options, lang, state);
      const idx = plan.steps.indexOf(step);

      if (result.userRejected) { userRejected = true; break; }

      if (result.stepPassed) {
        finalAssistantText = result.finalAssistantText || finalAssistantText;
        succeededStepIds.push(step.id);
        if (idx >= 0) stepStatuses[idx] = 'done';
      } else {
        failedStepIds.push(step.id);
        if (idx >= 0) stepStatuses[idx] = 'failed';
        log.error('Serial step failed after retries', { stepId: step.id });
      }
    } else {
      chWrite(chalk.gray(`  [orchestrator: dispatching ${batch.steps.length} steps in parallel]\n`));
      const workerResults = await runParallelBatch(batch, plan.steps.length, options, lang);

      // Summarize successful worker output into the main context so the
      // rest of the turn (and later steps) can see what was done — workers
      // run in isolated message arrays, so nothing they did is visible to
      // the main ContextManager unless we inject it here.
      const summaryLines: string[] = [];
      for (const step of batch.steps) {
        const r = workerResults.get(step.id);
        const idx = plan.steps.indexOf(step);
        if (r?.success) {
          succeededStepIds.push(step.id);
          if (idx >= 0) stepStatuses[idx] = 'done';
          summaryLines.push(`[Step ${step.id} — done] ${step.description}\n${r.output}`);
        } else {
          failedStepIds.push(step.id);
          if (idx >= 0) stepStatuses[idx] = 'failed';
          summaryLines.push(`[Step ${step.id} — FAILED] ${step.description}\nError: ${r?.error ?? 'unknown error'}`);
        }
      }
      if (summaryLines.length > 0) {
        context.push({ role: 'user', content: `[Orchestrator: parallel batch results]\n${summaryLines.join('\n\n')}` });
      }

      // Retry only the failed steps, sequentially, through the normal
      // single-step path (with its own refine/retry loop) — successful
      // steps in the batch are never re-run.
      for (const step of batch.steps) {
        if (!failedStepIds.includes(step.id)) continue;
        log.info('Retrying failed parallel step serially', { stepId: step.id });
        const retryResult = await runSingleStep(step, plan.steps.length, context, options, lang, state);
        const idx = plan.steps.indexOf(step);

        if (retryResult.userRejected) { userRejected = true; break; }

        if (retryResult.stepPassed) {
          finalAssistantText = retryResult.finalAssistantText || finalAssistantText;
          failedStepIds.splice(failedStepIds.indexOf(step.id), 1);
          succeededStepIds.push(step.id);
          if (idx >= 0) stepStatuses[idx] = 'done';
        } else {
          if (idx >= 0) stepStatuses[idx] = 'failed';
        }
      }

      if (succeededStepIds.length > 0 && !finalAssistantText) {
        // Parallel workers return plain text summaries, not the rich
        // pipeline assistantText — fall back to the last successful
        // worker's output so the turn has *something* to show if every
        // later step is also a parallel batch with no serial tail.
        const lastOk = batch.steps.find(s => succeededStepIds.includes(s.id));
        if (lastOk) finalAssistantText = workerResults.get(lastOk.id)?.output ?? finalAssistantText;
      }
    }

    printPlanTree(plan, stepStatuses);

    const batchEvent: OrchestratorBatchEvent = {
      type: 'orchestrator:batch',
      batchIndex: batchIdx,
      mode: batch.mode,
      stepIds: batch.steps.map(s => s.id),
      succeededStepIds,
      failedStepIds,
      durationMs: Date.now() - batchStart,
      timestamp: Date.now(),
    };
    bus.emit(batchEvent);

    if (userRejected) break;
  }

  return { finalAssistantText, userRejected, stepStatuses };
}
