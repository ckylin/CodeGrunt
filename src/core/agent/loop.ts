// ── Agent Loop with P/G/E Architecture ────────────────────────────────────
// Planner / Generator / Evaluator pattern adapted for DeepSeek models.
//
// Flow:
//   1. Planner analyzes the task → produces structured TaskPlan (2-5 steps)
//   2. For each plan step:
//      a. Generator (existing pipeline stages) executes the step
//      b. Evaluator checks output quality / plan adherence / hallucinations
//      c. If evaluation fails → Refiner feeds issues back, retries (max 2x)
//   3. Final summary output
//
// DeepSeek adaptation:
//   - Planner uses low-temperature (0.1) structured JSON output
//   - Evaluator combines structural checks (no LLM) + LLM quality assessment
//   - Max 2 refines per step to avoid infinite loops
//   - Fallback to single-step execution if planning fails
//
// Ref: pipeline/types.ts for TaskPlan, EvaluationResult
// Ref: planner.ts, evaluator.ts for P/E implementations
// Ref: pipeline/stages/*.ts for Generator stages

import type { AgentRunOptions, Message, ToolCall, ToolCallMessage } from '../../types.js';
import chalk from 'chalk';
import ora from 'ora';
import { ContextManager } from '../context/manager.js';
import { loadProjectGuide } from '../context/project-guide.js';
import { getToolDefinitions } from '../tools/registry.js';
import { resetYesAll, isYesAllActive } from '../pipeline/stages/process-tools-helpers.js';
import { confirmYesNo } from '../../utils/confirm.js';
import { detectInputLanguage } from '../memory/habits.js';
import type { TurnSignal } from '../../types.js';
import {
  printAssistantHeader, printThinkingCollapsed,
  printPlanHeader, printStepProgress, printEvaluation, printRefineIndicator,
  printIntentResult,
} from '../../utils/display.js';
import { MarkdownRenderer } from '../../utils/markdown.js';
import { CHAT_CONTEXT_BUDGET } from '../../config.js';
import { detectSystemLanguage } from '../../utils/locale.js';
import { compactMessages } from '../context/compact.js';
import { isReasonerModel } from '../../config.js';
import { saveSessionSummary } from '../memory/store.js';

// ── P/G/E modules ────────────────────────────────────────────────────────
import { detectIntent } from './intentor.js';
import { generatePlan } from './planner.js';
import { evaluateStep } from './evaluator.js';
import type { TaskPlan, EvaluationResult, IntentResult } from '../pipeline/types.js';

// ── Pipeline imports ─────────────────────────────────────────────────────
import {
  PipelineEngine,
  PipelineBuilder,
} from '../pipeline/engine.js';
import type { PipelineContext } from '../pipeline/types.js';
import type { StreamEmitter } from '../pipeline/types.js';
import { PrepareContextStage } from '../pipeline/stages/prepare-context.js';
import { StreamResponseStage } from '../pipeline/stages/stream-response.js';
import { ProcessToolCallsStage } from '../pipeline/stages/process-tools.js';
import { PostProcessStage } from '../pipeline/stages/post-process.js';

// ── Event bus / Observability ────────────────────────────────────────────
import { getDefaultEventBus, type ErrorEvent } from '../events/bus.js';
import { getDefaultMetrics } from '../observability/metrics.js';
import { getLogger } from '../observability/logger.js';

const log = getLogger('agent');

const MAX_ITERATIONS = 30;
const MAX_REFINE_RETRIES = 3;

// ── UI-aware StreamEmitter ────────────────────────────────────────────────

class UIStreamEmitter implements StreamEmitter {
  private md = new MarkdownRenderer();
  private assistantTextStarted = false;
  private thinkingStartTime: number | null = null;
  private reasoningText = '';
  private outputTokens = 0;
  private thinkingSpinner = ora({ text: chalk.gray('Thinking...'), color: 'gray', stream: process.stdout });
  private startTime: number;
  private iteration: number;
  private onText?: (text: string) => void;

  constructor(iteration: number, onText?: (text: string) => void) {
    this.iteration = iteration;
    this.startTime = Date.now();
    this.onText = onText;
  }

  private updateThinkingText(): void {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const iterInfo = this.iteration > 0 ? ` . iter ${this.iteration + 1}/${MAX_ITERATIONS}` : '';
    this.thinkingSpinner.text = chalk.gray(`Thinking... (${elapsed}s . ${this.outputTokens} tokens${iterInfo}  Esc to cancel)`);
  }

  showThinking(): void {
    if (!this.thinkingSpinner.isSpinning) {
      this.thinkingSpinner.start();
      this.updateThinkingText();
      const ticker = setInterval(() => {
        if (this.thinkingSpinner.isSpinning) this.updateThinkingText();
        else clearInterval(ticker);
      }, 1000);
    } else {
      this.updateThinkingText();
    }
  }

  hideThinking(): void {
    if (this.thinkingSpinner.isSpinning) {
      this.thinkingSpinner.stop();
    }
  }

  onTextDelta(text: string): void {
    this.hideThinking();
    if (!this.assistantTextStarted) {
      printAssistantHeader();
      this.assistantTextStarted = true;
    }
    this.outputTokens += Math.ceil(text.length / 4);
    this.onText?.(text);
    const formatted = this.md.feed(text);
    if (formatted) process.stdout.write(formatted);
  }

  onReasoningDelta(text: string): void {
    if (this.thinkingStartTime === null) this.thinkingStartTime = Date.now();
    this.reasoningText += text;
    this.outputTokens += Math.ceil(text.length / 4);
    this.showThinking();
  }

  onToolCallDelta(_index: number, _id?: string, _name?: string, _argsDelta?: string): void {
    // Silently accumulated — handled by StreamResponseStage
  }

  onFinish(_reason: string): void {
    this.hideThinking();
    const flushOut = this.md.flush();
    if (flushOut) process.stdout.write(flushOut);

    if (this.reasoningText && this.thinkingStartTime !== null) {
      const elapsed = Date.now() - this.thinkingStartTime;
      printThinkingCollapsed(this.reasoningText, elapsed);
    }
  }
}

// ── Tool call display helper ──────────────────────────────────────────────
// Tool calls are displayed in real-time by ProcessToolCallsStage (spinner + duration).
// This function only fires external callbacks for programmatic observers.

function displayToolCalls(
  pipeCtx: PipelineContext,
  onToolCall?: (name: string, args: Record<string, unknown>) => void,
  onToolResult?: (name: string, result: { success: boolean; output: string; error?: string }) => void,
): void {
  for (const tc of pipeCtx.toolCalls) {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch { /* ignore */ }

    onToolCall?.(tc.function.name, parsedArgs);

    const resultMsg = pipeCtx.messages
      .filter(m => m.role === 'tool')
      .find(m => 'tool_call_id' in m && m.tool_call_id === tc.id);
    if (resultMsg) {
      const toolResult = {
        success: !String(resultMsg.content).startsWith('Error:') && !String(resultMsg.content).startsWith('Failed'),
        output: String(resultMsg.content),
        error: String(resultMsg.content).startsWith('Error:') || String(resultMsg.content).startsWith('Failed')
          ? String(resultMsg.content) : undefined,
      };
      onToolResult?.(tc.function.name, toolResult);
    }
  }
}

// ── Generator: runs one turn of the existing pipeline ────────────────────

interface GeneratorResult {
  pipeCtx: PipelineContext;
  done: boolean;
  userRejected: boolean;
  error?: Error;
  stopReason?: 'stop' | 'length' | 'tool_calls' | 'max_iterations';
  hasReadThisTurn: boolean;
}

async function runGenerator(
  context: ContextManager,
  options: AgentRunOptions,
  lang: 'zh' | 'en',
  iteration: number,
  stepDescription?: string,
  sessionHasRead = false,
): Promise<GeneratorResult> {
  const { task, cwd, config, provider, onText, signal } = options;
  const toolDefs = getToolDefinitions();
  const engine = new PipelineEngine();

  // Build pipeline
  const builder = new PipelineBuilder()
    .name(`agent-turn-${iteration}`);

  if (iteration === 0) {
    builder.addStage(new PrepareContextStage());
  }

  const emitter = new UIStreamEmitter(iteration, onText);
  builder.addStage(new StreamResponseStage({ emitter }));
  builder.addStage(new ProcessToolCallsStage());
  builder.addStage(new PostProcessStage());

  const pipeline = builder.build();

  // If we have a step description, use it as the primary instruction with
  // the original task demoted to background context. This prevents the model
  // from trying to complete all steps in the first turn.
  const effectiveTask = stepDescription
    ? `## Current Step\n${stepDescription}\n\n## Background Context\n${task}`
    : task;

  const pipeCtx: PipelineContext = {
    cwd,
    config,
    provider,
    messages: context.getMessages(),
    systemPrompt: '',
    isReasoner: false,
    task: effectiveTask,
    toolDefinitions: toolDefs,
    signal,
    maxIterations: MAX_ITERATIONS,
    iteration,
    reasoningText: '',
    assistantText: '',
    toolCalls: [],
    finishReason: null,
    outputTokens: 0,
    hasReadThisTurn: sessionHasRead,
    warnedBlindWrite: false,
    language: lang,
    systemPromptOverride: options.systemPromptOverride,
    memorySummary: options.memorySummary,
    userPreferences: options.userPreferences,
  };

  const result = await engine.execute(pipeline, pipeCtx);
  context.setMessages(pipeCtx.messages);

  return {
    pipeCtx,
    done: pipeCtx.finishReason === 'stop' || pipeCtx.finishReason === 'length',
    userRejected: result.userRejected,
    error: result.error,
    stopReason: pipeCtx.finishReason === 'stop' ? 'stop'
      : pipeCtx.finishReason === 'length' ? 'length'
      : pipeCtx.toolCalls.length > 0 ? 'tool_calls'
      : 'stop',
    hasReadThisTurn: pipeCtx.hasReadThisTurn,
  };
}

// ── Main Agent Loop (P/G/E orchestration) ────────────────────────────────

export async function runAgentLoop(options: AgentRunOptions): Promise<void> {
  const { task, cwd, config, provider, onText, onToolCall, onToolResult, signal } = options;
  const model = config.model;

  const context = options.context ?? new ContextManager(CHAT_CONTEXT_BUDGET);
  const lang = detectSystemLanguage();
  const metrics = getDefaultMetrics();
  const bus = getDefaultEventBus();
  metrics.increment('agent.turns');

  resetYesAll();

  // Auto-compact: if the context flagged itself as near-capacity on the previous
  // turn, summarize before running the next agent turn so history is preserved
  // rather than silently dropped. Runs a single LLM call to produce the summary.
  if (context.needsCompact) {
    context.needsCompact = false;
    process.stdout.write(chalk.gray('  [compacting context'));
    try {
      const compactResult = await compactMessages(context.getMessages(), {
        provider,
        model,
        isReasoner: isReasonerModel(model),
        language: lang,
        signal,
      });
      if (compactResult) {
        context.compact(compactResult.summary);
        saveSessionSummary(cwd, compactResult.summary).catch(() => {});
        process.stdout.write(chalk.gray(`  ${compactResult.beforeTokens}→${compactResult.afterTokens} tokens]\n`));
        log.info('Auto-compact complete', { before: compactResult.beforeTokens, after: compactResult.afterTokens });
      } else {
        process.stdout.write(chalk.gray('  skipped]\n'));
      }
    } catch (err) {
      process.stdout.write(chalk.gray('  failed, continuing]\n'));
      log.warn('Auto-compact failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // ══════════════════════════════════════════════════════════════════════

  log.info('Phase 0: Intentor — classifying intent');

  let intent: IntentResult;
  try {
    intent = await detectIntent(provider, model, task, lang, signal, options.skills ?? []);
  } catch {
    intent = { isCoding: true, confidence: 50, reason: 'classification error'};
  }

  printIntentResult(intent);
  log.info('Intent classified', { isCoding: intent.isCoding, confidence: intent.confidence, matchedSkill: intent.matchedSkill?.name });

  // Subscribe to tool:result events to collect per-turn confirmation stats
  const turnStats = { toolCallCount: 0, confirmations: 0, rejections: 0 };
  const unsubToolResult = bus.on<import('../events/bus.js').ToolResultEvent>('tool:result', (e) => {
    turnStats.toolCallCount++;
    if (e.userRejected) turnStats.rejections++;
    else if (e.success) turnStats.confirmations++;
  });

  let responseLength = 0;
  try {
    if (intent.matchedSkill) {
      ({ responseLength } = await runSkillFlow(options, context, lang, intent.matchedSkill, metrics));
    } else if (intent.isCoding) {
      ({ responseLength } = await runCodingFlow(options, context, lang, intent, metrics, bus));
    } else {
      ({ responseLength } = await runChatFlow(options, context, lang, metrics));
    }
  } finally {
    unsubToolResult();
    // Emit per-turn signal for habit tracking — runs even on abort/throw so
    // aborted turns are still counted in habitState.
    const signal_: TurnSignal = {
      userInputLength: task.length,
      userInputLang:   detectInputLanguage(task),
      responseLength,
      isCoding:        intent.isCoding,
      toolCallCount:   turnStats.toolCallCount,
      confirmations:   turnStats.confirmations,
      rejections:      turnStats.rejections,
      yesAll:          isYesAllActive(),
      aborted:         signal?.aborted ?? false,
    };
    options.onTurnComplete?.(signal_);
  }
}

// ── Skill flow: apply skill system prompt + content, then chat-style gen ──

async function runSkillFlow(
  options: AgentRunOptions,
  context: ContextManager,
  lang: 'zh' | 'en',
  skill: NonNullable<IntentResult['matchedSkill']>,
  metrics: ReturnType<typeof getDefaultMetrics>,
): Promise<{ responseLength: number }> {
  const { onToolCall, onToolResult, signal } = options;

  log.info('Skill flow', { skill: skill.name });
  process.stdout.write(chalk.gray(`  skill: ${skill.name}\n`));

  // Prepend skill content to the user task so the model has full context
  const skillTask = `${skill.content}\n\n---\n${options.task}`;
  const skillOptions: AgentRunOptions = {
    ...options,
    task: skillTask,
    systemPromptOverride: skill.system,
  };

  const genResult = await runGenerator(context, skillOptions, lang, 0);

  if (genResult.userRejected) { log.info('Skill flow ended — user rejected'); return { responseLength: 0 }; }
  if (genResult.error) throw genResult.error;

  displayToolCalls(genResult.pipeCtx, onToolCall, onToolResult);

  // Continue if the model made tool calls
  let iteration = 1;
  let current = genResult;
  while (!current.done && current.pipeCtx.toolCalls.length > 0 && iteration < MAX_ITERATIONS) {
    if (signal?.aborted) break;
    current = await runGenerator(context, skillOptions, lang, iteration);
    if (current.userRejected) break;
    if (current.error) throw current.error;
    displayToolCalls(current.pipeCtx, onToolCall, onToolResult);
    iteration++;
  }

  log.info('Skill flow complete', { skill: skill.name, iterations: iteration });
  metrics.increment('agent.skill_turns');
  return { responseLength: current.pipeCtx.assistantText.length };
}

// ── Coding flow: Planner → Generator → Evaluator ─────────────────────────

function pruneRefineMessages(context: ContextManager): void {
  const filtered = context.getMessages().filter(m => {
    if (m.role !== 'user') return true;
    const text = typeof m.content === 'string' ? m.content : '';
    return !text.startsWith('[评估反馈]') && !text.startsWith('[Evaluation Feedback]');
  });
  context.setMessages(filtered);
}

async function runCodingFlow(
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

  for (let stepIdx = 0; stepIdx < plan.steps.length; stepIdx++) {
    if (signal?.aborted) break;

    const step = plan.steps[stepIdx];
    printStepProgress(stepIdx, plan.steps.length, step.description);

    let stepPassed = false;
    let lastEval: EvaluationResult | null = null;

    for (let refineCount = 0; refineCount <= MAX_REFINE_RETRIES; refineCount++) {
      if (signal?.aborted) break;

      const stepDesc = refineCount === 0
        ? `Step ${step.id}/${plan.steps.length}: ${step.description}\nExpected: ${step.expectedOutcome}`
        : `RETRY Step ${step.id}: ${step.description}\nPrevious issues:\n${(lastEval?.issues ?? []).map(i => `- ${i}`).join('\n')}\n\nSuggestions:\n${(lastEval?.suggestions ?? []).map(s => `- ${s}`).join('\n')}\n\nPlease fix the issues and re-execute.`;

      // Run the generator and keep iterating within this step as long as the
      // model continues making tool calls (mirrors the runChatFlow while loop).
      let genResult = await runGenerator(
        context,
        options,
        lang,
        stepIdx * (MAX_REFINE_RETRIES + 1) + refineCount,
        stepDesc,
        sessionHasRead,
      );

      if (genResult.hasReadThisTurn) sessionHasRead = true;

      if (genResult.userRejected) { userRejected = true; break; }
      if (genResult.error) { log.error('Generator error', { error: genResult.error.message }); throw genResult.error; }

      displayToolCalls(genResult.pipeCtx, onToolCall, onToolResult);

      {
        let innerIter = 1;
        while (!genResult.done && genResult.pipeCtx.toolCalls.length > 0 && innerIter < MAX_ITERATIONS) {
          if (signal?.aborted) break;
          const next = await runGenerator(
            context,
            options,
            lang,
            stepIdx * (MAX_REFINE_RETRIES + 1) * MAX_ITERATIONS + innerIter,
            stepDesc,
            sessionHasRead,
          );
          if (next.hasReadThisTurn) sessionHasRead = true;
          if (next.userRejected) { userRejected = true; break; }
          if (next.error) throw next.error;
          displayToolCalls(next.pipeCtx, onToolCall, onToolResult);
          genResult = next;
          innerIter++;
        }
        if (userRejected) break;
      }

      // Extract current-turn tool calls and results for the evaluator
      const currentTurnToolCalls = genResult.pipeCtx.toolCalls.map(tc => ({
        name: tc.function.name,
        args: tc.function.arguments,
      }));
      const currentTurnToolResults = genResult.pipeCtx.messages
        .filter(m => m.role === 'tool' && 'tool_call_id' in m)
        .map(m => ({ content: String(m.content) }));

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
        } else {
          userRejected = true;
          break;
        }
      }
    }

    if (userRejected) break;
    if (!stepPassed) log.error('Step failed after all retries', { stepId: step.id });
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

// ── Chat flow: (optional lightweight plan) → Generator only ──────────────

async function runChatFlow(
  options: AgentRunOptions,
  context: ContextManager,
  lang: 'zh' | 'en',
  metrics: ReturnType<typeof getDefaultMetrics>,
): Promise<{ responseLength: number }> {
  const { task, onToolCall, onToolResult, signal } = options;

  log.info('Phase 1 (chat): direct generation — no Evaluator');

  const genResult = await runGenerator(context, options, lang, 0);

  if (genResult.userRejected) { log.info('Chat flow ended — user rejected'); return { responseLength: 0 }; }
  if (genResult.error) throw genResult.error;

  displayToolCalls(genResult.pipeCtx, onToolCall, onToolResult);

  // If the model made tool calls (e.g. read_file for context), continue
  // iterating until it stops — same as the old single-step loop.
  let iteration = 1;
  let current = genResult;
  while (!current.done && current.pipeCtx.toolCalls.length > 0 && iteration < MAX_ITERATIONS) {
    if (signal?.aborted) break;
    current = await runGenerator(context, options, lang, iteration);
    if (current.userRejected) break;
    if (current.error) throw current.error;
    displayToolCalls(current.pipeCtx, onToolCall, onToolResult);
    iteration++;
  }

  // If the final turn produced no visible text, print a fallback so the user
  // knows the turn completed (avoids silent no-op when the model returns empty).
  const finalText = current.pipeCtx.assistantText;
  if (!finalText && current.pipeCtx.toolCalls.length === 0) {
    const fallback = lang === 'zh'
      ? chalk.gray('  (模型未返回文本响应)\n')
      : chalk.gray('  (no text response from model)\n');
    process.stdout.write(fallback);
  }

  log.info('Chat flow complete', { iterations: iteration });
  metrics.increment('agent.chat_turns');
  return { responseLength: current.pipeCtx.assistantText.length };
}
