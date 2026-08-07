// ── Agent Loop with P/G/E Architecture ────────────────────────────────────
// Planner / Generator / Evaluator pattern adapted for DeepSeek models.
//
// The agent loop orchestrates intent detection, model routing, and dispatches
// to one of three execution flows:
//   - coding-flow.ts: Planner → Generator → Evaluator (P/G/E) for code tasks
//   - chat-flow.ts:   Direct generation, no planner/evaluator
//   - skill-flow.ts:  Skill system prompt + content, inline or subagent mode
//
// Ref: pipeline/types.ts for TaskPlan, EvaluationResult
// Ref: generator.ts for shared runGenerator, UIStreamEmitter, constants
// Ref: coding-flow.ts, chat-flow.ts, skill-flow.ts for flow implementations

import type { AgentRunOptions } from '../../types.js';
import chalk from 'chalk';
import { ContextManager } from '../context/manager.js';
import { resetYesAll, isYesAllActive, setTrustMode, setWorkspacePermissions } from '../pipeline/stages/process-tools-helpers.js';
import { loadWorkspacePermissions } from '../permissions/index.js';
import { detectInputLanguage } from '../memory/habits.js';
import type { TurnSignal } from '../../types.js';
import { printIntentResult } from '../../utils/display.js';
import { CHAT_CONTEXT_BUDGET } from '../../config.js';
import { detectSystemLanguage } from '../../utils/locale.js';
import { compactMessages } from '../context/compact.js';
import { saveSessionSummary } from '../memory/store.js';
import { getHookRegistry } from '../hooks/registry.js';
import { createSnapshot } from '../snapshot/index.js';
import { setSubagentContext } from './subagent.js';

// ── P/G/E modules ────────────────────────────────────────────────────────
import { detectIntent, selectModelForTask } from './intentor.js';
import { classifyComplexity } from './complexity.js';
import type { IntentResult } from '../pipeline/types.js';

// ── Flow dispatchers ─────────────────────────────────────────────────────
import { runCodingFlow } from './coding-flow.js';
import { runChatFlow } from './chat-flow.js';
import { runSkillFlow } from './skill-flow.js';

// ── Event bus / Observability ────────────────────────────────────────────
import { getDefaultEventBus } from '../events/bus.js';
import { getDefaultMetrics } from '../observability/metrics.js';
import { getLogger } from '../observability/logger.js';

const log = getLogger('agent');

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

  // Auto-routing thinking mode based on complexity tier.
  // Simple tasks → thinking disabled (save output tokens)
  // Complex tasks → thinking enabled (when autoThinkingMode is on)
  // Medium tasks → model default (undisturbed)
  const complexity = classifyComplexity(task);
  if (complexity.isCode) {
    if (complexity.tier === 'simple') {
      activeOptions = { ...activeOptions, thinking: 'disabled' as const };
      process.stdout.write(chalk.gray(`  [thinking: disabled (simple task)]\n`));
      log.info('Thinking disabled for simple task');
    } else if (complexity.tier === 'complex') {
      const autoThinking = config.autoThinkingMode ?? true;
      if (autoThinking) {
        activeOptions = { ...activeOptions, thinking: 'enabled' as const };
        process.stdout.write(chalk.gray(`  [thinking: enabled (complex task)]\n`));
        log.info('Thinking enabled for complex task');
      }
    }
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
