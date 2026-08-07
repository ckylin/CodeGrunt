// ── Stage 3: Process Tool Calls ─────────────────────────────────────────────
// Executes tool calls returned by the model, handles confirm flow for
// destructive operations, tracks read/write patterns for anti-hallucination.
//
// Ref: Original tool execution logic extracted from src/core/agent/loop.ts
// and src/core/tools/executor.ts

import type { Stage, StageResult, PipelineContext } from '../types.js';
import type { ToolCallMessage } from '../../../types.js';
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../types.js';
import { executeToolCall, repairToolArgs } from './process-tools-helpers.js';
import { getLogger } from '../../observability/logger.js';
import { getDefaultEventBus, type ToolCallEvent, type ToolResultEvent } from '../../events/bus.js';
import { getDefaultMetrics } from '../../observability/metrics.js';
import { createToolSpinner, type ToolSpinner } from '../../../utils/tool-spinner.js';
import { getHookRegistry } from '../../hooks/registry.js';
import { runDiagnostics, formatDiagnostics } from '../../lsp/checker.js';

const log = getLogger('stage:process-tools');

export class ProcessToolCallsStage implements Stage {
  readonly name = 'process-tool-calls';

  async execute(ctx: PipelineContext): Promise<StageResult> {
    if (ctx.finishReason !== 'tool_calls' || ctx.toolCalls.length === 0) {
      return { continue: true, done: false };
    }

    const bus = getDefaultEventBus();
    const metrics = getDefaultMetrics();

    // Push assistant(tool_calls) message to context
    ctx.messages.push({
      role: 'assistant',
      content: null,
      tool_calls: ctx.toolCalls,
      ...(ctx.reasoningText ? { reasoning_content: ctx.reasoningText } : {}),
    } as ToolCallMessage);

    // Anti-hallucination: detect blind write pattern
    const hasWriteInBatch = ctx.toolCalls.some(tc => WRITE_TOOL_NAMES.has(tc.function.name));
    const hasReadInBatch = ctx.toolCalls.some(tc => READ_TOOL_NAMES.has(tc.function.name));
    const shouldWarnBlindWrite = hasWriteInBatch && !hasReadInBatch && !ctx.hasReadThisTurn && !ctx.warnedBlindWrite;

    // Keep a reference to the assistant message we just pushed so we can trim
    // its tool_calls array if the user rejects partway through a batch.
    const assistantMsg = ctx.messages[ctx.messages.length - 1] as import('../../../types.js').ToolCallMessage;

    for (let tcIndex = 0; tcIndex < ctx.toolCalls.length; tcIndex++) {
      const tc = ctx.toolCalls[tcIndex];
      let parsedArgs: Record<string, unknown> = {};
      const repaired = repairToolArgs(tc.function.arguments);
      if (repaired !== null) {
        parsedArgs = repaired;
      } else {
        log.warn('Failed to parse tool call arguments after repair attempts', {
          tool: tc.function.name,
          raw: tc.function.arguments.slice(0, 200),
        });
      }

      // Track reads for blind-write detection
      if (READ_TOOL_NAMES.has(tc.function.name)) {
        ctx.hasReadThisTurn = true;
      }

      // Emit event
      const toolStartTime = Date.now();
      const toolEvent: ToolCallEvent = {
        type: 'tool:called',
        toolName: tc.function.name,
        args: parsedArgs,
        iteration: ctx.iteration,
        timestamp: toolStartTime,
      };
      bus.emit(toolEvent);

      metrics.increment(`tool.${tc.function.name}.calls`);
      const toolTimer = metrics.startTimer(`tool.${tc.function.name}`);

      // ── Start spinner for this tool call ────────────────────────────
      const spinner: ToolSpinner = createToolSpinner(tc.function.name, parsedArgs);

      // ── PreToolUse hook ──────────────────────────────────────────────
      const hooks = getHookRegistry();
      const preHookResult = await hooks.run({
        event: 'pre-tool-use',
        tool_name: tc.function.name,
        tool_input: parsedArgs,
        cwd: ctx.cwd,
      });
      if (preHookResult.action === 'block') {
        spinner.done(false, 0, `Blocked by hook: ${preHookResult.reason}`);
        ctx.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `[Tool call blocked by hook: ${preHookResult.reason}]`,
        });
        assistantMsg.tool_calls = ctx.toolCalls.slice(0, tcIndex + 1);
        return { continue: false, done: true, userRejected: true };
      }
      // Allow hooks to rewrite tool input (e.g. sanitize args)
      const effectiveArgs = preHookResult.action === 'modify'
        ? { ...parsedArgs, ...preHookResult.data }
        : parsedArgs;
      const effectiveArgsJson = preHookResult.action === 'modify'
        ? JSON.stringify(effectiveArgs)
        : tc.function.arguments;

      let result;
      try {
        result = await executeToolCall(tc.function.name, effectiveArgsJson, ctx.cwd);
      } catch (err) {
        result = {
          success: false,
          output: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      toolTimer();

      const totalDurationMs = Date.now() - toolStartTime;
      const confirmDurationMs = result.confirmDurationMs ?? 0;
      const execDurationMs = Math.max(0, totalDurationMs - confirmDurationMs);

      // ── Stop spinner, show result with duration ─────────────────────
      spinner.done(result.success, execDurationMs, result.error);

      // Emit result event
      const resultEvent: ToolResultEvent = {
        type: 'tool:result',
        toolName: tc.function.name,
        success: result.success,
        error: result.error,
        userRejected: result.userRejected,
        timestamp: Date.now(),
      };
      bus.emit(resultEvent);

      // ── PostToolUse hook ─────────────────────────────────────────────
      await hooks.run({
        event: 'post-tool-use',
        tool_name: tc.function.name,
        tool_input: effectiveArgs,
        tool_result: {
          success: result.success,
          output: result.output,
          error: result.error,
        },
        cwd: ctx.cwd,
      });

      if (!result.success) {
        metrics.increment(`tool.${tc.function.name}.errors`);
      }

      if (result.userRejected) {
        // Push a cancellation result for this tool call
        ctx.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: '[Tool call cancelled by user]',
        });

        // Trim the assistant message's tool_calls to only the calls that
        // actually ran (up to and including the rejected one), so the history
        // stays consistent when the batch has more calls that were never executed.
        assistantMsg.tool_calls = ctx.toolCalls.slice(0, tcIndex + 1);

        log.info('Tool call rejected by user', { tool: tc.function.name, batchIndex: tcIndex, batchTotal: ctx.toolCalls.length });
        return { continue: false, done: true, userRejected: true };
      }

      // Push tool result to context.
      // On failure: include both the error summary AND the actual output (stdout+stderr),
      // so the model has enough context to diagnose the root cause without guessing.
      let toolContent: string;
      if (result.success) {
        toolContent = result.output;
      } else {
        const errorLine = result.error ?? 'Tool failed';
        const outputBody = result.output?.trim();
        toolContent = outputBody
          ? `${errorLine}\n\nOutput:\n${outputBody}`
          : errorLine;
      }
      ctx.messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolContent,
      });
    }

    // Inject blind-write warning after all tool results
    if (shouldWarnBlindWrite) {
      ctx.warnedBlindWrite = true;
      const warning = ctx.language === 'zh'
        ? '⚠️ 检测到直接写入操作：你尚未读取任何项目文件就尝试编辑代码。这极大增加了凭空编造不存在的 API/类型/模式的风险。建议在写入之前先用 read_file 或 search_files 了解现有代码风格和可用的接口。'
        : '⚠️ Blind write detected: you are attempting to edit code without having read any project files first. This greatly increases the risk of inventing non-existent APIs, types, or patterns. Consider using read_file or search_files to ground yourself before writing.';
      ctx.messages.push({ role: 'user', content: warning });
      log.warn('Blind write warning injected');
    }

    // Run language diagnostics after write/edit operations.
    // Only inject if there are actual errors — warnings alone don't block progress.
    const hadWrite = ctx.toolCalls.some(tc => WRITE_TOOL_NAMES.has(tc.function.name));
    if (hadWrite) {
      try {
        const diagnostics = await runDiagnostics(ctx.cwd);
        const errors = diagnostics.filter(d => !d.passed);
        if (errors.length > 0) {
          const msg = formatDiagnostics(errors, ctx.language);
          ctx.messages.push({ role: 'user', content: msg });
          log.info('Diagnostics injected', { errors: errors.map(d => `${d.language}:${d.errorCount}`) });
        }
      } catch {
        // Diagnostics are best-effort — never crash the pipeline
      }
    }

    return { continue: true, done: false };
  }
}

// ── Tool execution helper (extracted from executor) ──────────────────────
// Imported from process-tools-helpers to keep this file focused on the stage logic
