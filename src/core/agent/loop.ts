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
import { resetYesAll, isYesAllActive, setTrustMode, setWorkspacePermissions } from '../pipeline/stages/process-tools-helpers.js';
import { loadWorkspacePermissions } from '../permissions/index.js';
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
import { getHookRegistry } from '../hooks/registry.js';
import { createSnapshot } from '../snapshot/index.js';
import { setSubagentContext, runSubagent } from './subagent.js';

// ── P/G/E modules ────────────────────────────────────────────────────────
import { detectIntent, selectModelForTask } from './intentor.js';
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
import { PrepareContextStage, pushUserMessage } from '../pipeline/stages/prepare-context.js';
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
  prepareStage?: PrepareContextStage,
  /** When true, skip pushing the user message — used for inner tool-call
   *  iterations where the prompt already has the most recent instruction. */
  skipUserMessage = false,
): Promise<GeneratorResult> {
  const { task, cwd, config, provider, onText, signal } = options;
  const toolDefs = getToolDefinitions();
  const engine = new PipelineEngine();

  // Build pipeline
  const builder = new PipelineBuilder()
    .name(`agent-turn-${iteration}`);

  // PrepareContextStage runs only on the very first iteration of a session
  // (iteration=0). It initialises the system prompt and pushes the system
  // message once. User messages are pushed below for EVERY call so that
  // refine-loop turns and multi-step turns also receive the right instruction.
  if (iteration === 0) {
    builder.addStage(prepareStage ?? new PrepareContextStage());
  }

  const emitter = new UIStreamEmitter(iteration, onText);
  builder.addStage(new StreamResponseStage({ emitter }));
  builder.addStage(new ProcessToolCallsStage());
  builder.addStage(new PostProcessStage());

  const pipeline = builder.build();

  const effectiveTask = stepDescription
    ? `## Current Step\n${stepDescription}\n\n## Background Context\n${task}`
    : task;

  // Snapshot the current messages. If pipeline throws, context stays clean.
  const messageSnapshot = [...context.getMessages()];

  const pipeCtx: PipelineContext = {
    cwd,
    config,
    provider,
    messages: messageSnapshot,
    systemPrompt: '',
    isReasoner: isReasonerModel(config.model),
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

  // Always push the user message for this turn.
  // For inner tool-call iterations (skipUserMessage=true), the instruction is
  // already in context from the outer call — pushing it again wastes tokens.
  if (!skipUserMessage) {
    pushUserMessage(pipeCtx, effectiveTask);
  }

  let result;
  try {
    result = await engine.execute(pipeline, pipeCtx);
  } catch (err) {
    // Pipeline threw — do NOT write back the half-modified snapshot
    return {
      pipeCtx,
      done: false,
      userRejected: false,
      error: err instanceof Error ? err : new Error(String(err)),
      stopReason: 'stop',
      hasReadThisTurn: pipeCtx.hasReadThisTurn,
    };
  }

  // Pipeline completed — write back to context manager
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
  // Language is detected once at REPL startup and passed in via options.
  // Fall back to detectSystemLanguage() only if not provided (e.g. in tests).
  const lang = options.language ?? detectSystemLanguage();
  const metrics = getDefaultMetrics();
  const bus = getDefaultEventBus();
  metrics.increment('agent.turns');

  resetYesAll();
  setTrustMode(options.config.trustMode ?? 'code');
  // agent_open needs a provider/model to spawn sub-agents with — set once per
  // turn before any tool call can run. Updated again below once the model is
  // auto-routed, so sub-agents inherit the same tier as the main turn.
  setSubagentContext(provider, model);
  // Workspace permissions are optional and best-effort — a missing or invalid
  // .codegrunt/permissions.json should never block the turn from starting.
  setWorkspacePermissions(await loadWorkspacePermissions(cwd).catch(() => null));

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

  // Auto-route to the appropriate model tier based on task complexity.
  // Only affects deepseek-v4-* variants; leaves other models unchanged.
  const routedModel = selectModelForTask(model, task, intent);
  let activeOptions = options;
  if (routedModel !== model) {
    process.stdout.write(chalk.gray(`  [auto-route: ${model} → ${routedModel}]\n`));
    log.info('Model auto-routed', { from: model, to: routedModel });
    activeOptions = { ...options, config: { ...config, model: routedModel } };
    setSubagentContext(provider, routedModel);
  }

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
      ({ responseLength } = await runSkillFlow(activeOptions, context, lang, intent.matchedSkill, metrics));
    } else if (intent.isCoding) {
      ({ responseLength } = await runCodingFlow(activeOptions, context, lang, intent, metrics, bus));
    } else {
      ({ responseLength } = await runChatFlow(activeOptions, context, lang, metrics));
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

    // ── Auto-snapshot ────────────────────────────────────────────────
    // Silently create a side-git snapshot after each coding turn so the
    // user can /restore if something goes wrong. Chat-only turns are skipped.
    if (signal_.isCoding || signal_.toolCallCount > 0) {
      createSnapshot(options.cwd, options.task).catch(() => {});
    }

    // ── Stop hook ────────────────────────────────────────────────────
    await getHookRegistry().run({
      event: 'stop',
      cwd: options.cwd,
      response_length: responseLength,
    });
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

    let stepPassed = false;
    let lastEval: EvaluationResult | null = null;

    for (let refineCount = 0; refineCount <= MAX_REFINE_RETRIES; refineCount++) {
      if (signal?.aborted) break;

      const stepDesc = refineCount === 0
        ? `Step ${step.id}/${plan.steps.length}: ${step.description}\nExpected: ${step.expectedOutcome}`
        : `RETRY Step ${step.id}: ${step.description}\nPrevious issues:\n${(lastEval?.issues ?? []).map(i => `- ${i}`).join('\n')}\n\nSuggestions:\n${(lastEval?.suggestions ?? []).map(s => `- ${s}`).join('\n')}\n\nPlease fix the issues and re-execute.`;

      let genResult = await runGenerator(
        context, options, lang, globalIter++, stepDesc, sessionHasRead, prepareStage,
      );

      if (genResult.hasReadThisTurn) sessionHasRead = true;
      if (genResult.userRejected) { userRejected = true; break; }
      if (genResult.error) { log.error('Generator error', { error: genResult.error.message }); throw genResult.error; }
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

// ── Chat flow: (optional lightweight plan) → Generator only ──────────────

async function runChatFlow(
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
    process.stdout.write(fallback);
  }

  log.info('Chat flow complete', { iterations: iteration });
  metrics.increment('agent.chat_turns');
  return { responseLength: current.pipeCtx.assistantText.length };
}
