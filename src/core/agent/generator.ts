// ── Shared Generator ─────────────────────────────────────────────────────
// Extracted from loop.ts — used by all three flow types (coding, chat, skill).
// Provides UIStreamEmitter, displayToolCalls, runGenerator, and the shared
// MAX_ITERATIONS / MAX_REFINE_RETRIES constants.
//
// Ref: pipeline/types.ts for PipelineContext, StreamEmitter
// Ref: pipeline/stages/*.ts for Stage implementations

import type { AgentRunOptions } from '../../types.js';
import chalk from 'chalk';
import ora from 'ora';
import { ContextManager } from '../context/manager.js';
import { getToolDefinitions } from '../tools/registry.js';
import {
  printAssistantHeader, printThinkingCollapsed,
} from '../../utils/display.js';
import { MarkdownRenderer } from '../../utils/markdown.js';
import { isReasonerModel } from '../../config.js';
import { setLiveTextDirect, commitLiveText, hasSink } from '../../cli/ink/output-channel.js';

// ── Pipeline imports ────────────────────────────────────────────────────
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

// ── Constants ───────────────────────────────────────────────────────────

export const MAX_ITERATIONS = 30;
export const MAX_REFINE_RETRIES = 3;

// ── UI-aware StreamEmitter ───────────────────────────────────────────────

export class UIStreamEmitter implements StreamEmitter {
  private md = new MarkdownRenderer();
  private assistantTextStarted = false;
  private thinkingStartTime: number | null = null;
  private reasoningText = '';
  private rawAssistantText = '';
  private outputTokens = 0;
  // ora's spinner writes raw ANSI cursor-movement bytes straight to
  // process.stdout on its own \80ms tick — safe only in fallback mode
  // (one-shot `codegrunt "<task>"`, no persistent App mounted). Once a sink
  // is registered, the persistent App's StatusBar already shows an
  // equivalent "Ns · Esc to cancel" readout (driven by AppHandle.setBusy()
  // in repl.ts) and Ink owns the terminal's live region — a second thing
  // moving the cursor on its own tick would tear the frame. hasSink() is
  // snapshotted once per emitter instance (one per runGenerator() call) —
  // it cannot change mid-turn since sink registration only happens at REPL
  // startup/shutdown, not during a turn.
  private readonly sinkMode = hasSink();
  private thinkingSpinner = this.sinkMode
    ? null
    : ora({ text: chalk.gray('Thinking...'), color: 'gray', stream: process.stdout });
  private startTime: number;
  private iteration: number;
  private onText?: (text: string) => void;

  constructor(iteration: number, onText?: (text: string) => void) {
    this.iteration = iteration;
    this.startTime = Date.now();
    this.onText = onText;
  }

  private updateThinkingText(): void {
    if (!this.thinkingSpinner) return;
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const iterInfo = this.iteration > 0 ? ` . iter ${this.iteration + 1}/${MAX_ITERATIONS}` : '';
    this.thinkingSpinner.text = chalk.gray(`Thinking... (${elapsed}s . ${this.outputTokens} tokens${iterInfo}  Esc to cancel)`);
  }

  showThinking(): void {
    if (!this.thinkingSpinner) return;
    if (!this.thinkingSpinner.isSpinning) {
      this.thinkingSpinner.start();
      this.updateThinkingText();
      const ticker = setInterval(() => {
        if (this.thinkingSpinner?.isSpinning) this.updateThinkingText();
        else clearInterval(ticker);
      }, 1000);
    } else {
      this.updateThinkingText();
    }
  }

  /** Show the waiting indicator before the first token arrives — covers
   *  non-reasoner models that never emit reasoning_delta chunks. */
  startThinking(): void {
    this.showThinking();
  }

  hideThinking(): void {
    if (this.thinkingSpinner?.isSpinning) {
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
    if (this.sinkMode) {
      // Sink mode re-renders the FULL accumulated raw text through a FRESH
      // MarkdownRenderer on every delta, rather than reusing this.md's
      // incremental feed()/flush() pair — that pair is stateful and
      // append-only (it commits each completed line exactly once and can't
      // re-render an already-committed line), which matches the fallback
      // path's one-shot stdout writes but not sink mode's "redraw the whole
      // live region from scratch" model. Re-parsing the whole buffer each
      // delta is more work per keystroke, but turn-length text streams are
      // small enough (low thousands of chars) that this is not a measurable
      // cost. Note this does NOT give an in-progress code block a live
      // preview before its closing ``` fence arrives — MarkdownRenderer
      // itself buffers a code block until it closes, in both modes — this
      // re-render only ensures completed lines/blocks appear correctly as
      // more text streams in after them, matching fallback mode's output
      // exactly rather than adding new formatting behavior.
      this.rawAssistantText += text;
      const liveRenderer = new MarkdownRenderer();
      setLiveTextDirect(liveRenderer.feed(this.rawAssistantText) + liveRenderer.flush());
    } else {
      const formatted = this.md.feed(text);
      if (formatted) process.stdout.write(formatted);
    }
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
    if (this.sinkMode) {
      commitLiveText();
    } else {
      const flushOut = this.md.flush();
      if (flushOut) process.stdout.write(flushOut);
    }

    if (this.reasoningText && this.thinkingStartTime !== null) {
      const elapsed = Date.now() - this.thinkingStartTime;
      printThinkingCollapsed(this.reasoningText, elapsed);
    }
  }
}

// ── Tool call display helper ────────────────────────────────────────────
// Tool calls are displayed in real-time by ProcessToolCallsStage (spinner + duration).
// This function only fires external callbacks for programmatic observers.

export function displayToolCalls(
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

// ── Generator: runs one turn of the existing pipeline ───────────────────

export interface GeneratorResult {
  pipeCtx: PipelineContext;
  done: boolean;
  userRejected: boolean;
  error?: Error;
  stopReason?: 'stop' | 'length' | 'tool_calls' | 'max_iterations';
  hasReadThisTurn: boolean;
}

export async function runGenerator(
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
    thinking: options.thinking,
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
    done: pipeCtx.finishReason === 'stop'
      || pipeCtx.finishReason === 'length'
      || (pipeCtx.finishReason === null && pipeCtx.toolCalls.length === 0),
    userRejected: result.userRejected,
    error: result.error,
    stopReason: pipeCtx.finishReason === 'stop' ? 'stop'
      : pipeCtx.finishReason === 'length' ? 'length'
      : pipeCtx.finishReason === 'tool_calls' ? 'tool_calls'
      : pipeCtx.toolCalls.length > 0 ? 'tool_calls'
      : 'stop',
    hasReadThisTurn: pipeCtx.hasReadThisTurn,
  };
}
