// ── Sub-agent Execution ─────────────────────────────────────────────────────
// Runs a focused, read-only research task in an isolated message context.
// Spawned by the main agent via the `agent_open` tool when a sub-question
// benefits from its own investigation loop (multi-file search, web lookup)
// without polluting the caller's context window.
//
// v1 scope (synchronous, single sub-agent at a time):
//   - No write_file / edit_file / execute_shell access — read-only tools only.
//     This sidesteps the confirm-dialog stdin/stdout contention that would
//     arise if multiple sub-agents ran destructive tools concurrently.
//   - Blocks the calling tool call until the sub-agent produces a final
//     text answer or exhausts its iteration budget.
//
// Ref: src/core/tools/agent_open.ts (the tool wrapper exposed to the model)

import type { LLMProvider, Message, ToolCallMessage, ToolDefinition } from '../../types.js';
import { getToolDefinitions } from '../tools/registry.js';
import { executeToolCall } from '../pipeline/stages/process-tools-helpers.js';
import { getLogger } from '../observability/logger.js';

const log = getLogger('subagent');

const MAX_SUBAGENT_ITERATIONS = 10;
const SUBAGENT_MAX_TOKENS = 4096;

/** Tools available to sub-agents — read-only, no confirm-gated operations. */
export const SUBAGENT_TOOL_NAMES = new Set([
  'read_file', 'search_files', 'list_directory', 'code_search', 'web_search', 'memory_read',
]);

export interface SubagentResult {
  success: boolean;
  output: string;
  toolCallCount: number;
  iterations: number;
  error?: string;
}

export interface SubagentRunOptions {
  task: string;
  cwd: string;
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
}

function getSubagentToolDefinitions(): ToolDefinition[] {
  return getToolDefinitions().filter(d => SUBAGENT_TOOL_NAMES.has(d.function.name));
}

function buildSubagentSystemPrompt(cwd: string): string {
  return `You are a read-only research sub-agent spawned by a coding agent to investigate a focused question in isolation.

- Available tools: read_file, search_files, list_directory, code_search, web_search, memory_read. You have NO access to write_file, edit_file, or execute_shell — any attempt to use them will fail.
- Working directory: ${cwd}
- There is no user in this conversation — only the calling agent waiting for your final answer. Do not ask questions; investigate with the tools available and reach a conclusion.
- When you have enough information, stop calling tools and reply with a concise, information-dense text answer.`;
}

/** Downgrade to the cheapest tier for sub-agent research — same policy as Intentor's classification calls. */
function selectSubagentModel(configuredModel: string): string {
  if (configuredModel.startsWith('deepseek-')) return 'deepseek-v4-flash';
  return configuredModel;
}

/**
 * Run a single sub-agent turn-loop to completion (or until MAX_SUBAGENT_ITERATIONS).
 * Synchronous from the caller's perspective — this promise resolves only once
 * the sub-agent has produced a final text answer or given up.
 */
export async function runSubagent(options: SubagentRunOptions): Promise<SubagentResult> {
  const { task, cwd, provider, signal } = options;
  const model = selectSubagentModel(options.model);
  const toolDefs = getSubagentToolDefinitions();

  const messages: Message[] = [
    { role: 'system', content: buildSubagentSystemPrompt(cwd) },
    { role: 'user', content: task },
  ];

  let toolCallCount = 0;
  let iteration = 0;
  let finalText = '';

  try {
    while (iteration < MAX_SUBAGENT_ITERATIONS) {
      if (signal?.aborted) {
        return { success: false, output: finalText, toolCallCount, iterations: iteration, error: 'Aborted' };
      }

      let assistantText = '';
      let finishReason: 'stop' | 'tool_calls' | 'length' | null = null;
      const accumulator = new Map<number, { id: string; name: string; arguments: string }>();

      const stream = provider.stream(messages, {
        model,
        maxTokens: SUBAGENT_MAX_TOKENS,
        temperature: 0.2,
        tools: toolDefs,
        signal,
      });

      for await (const chunk of stream) {
        if (signal?.aborted) break;
        if (chunk.type === 'text_delta') {
          assistantText += chunk.text;
        } else if (chunk.type === 'tool_call_delta') {
          const existing = accumulator.get(chunk.index) ?? { id: '', name: '', arguments: '' };
          if (chunk.id) existing.id = chunk.id;
          if (chunk.name) existing.name = chunk.name;
          existing.arguments += chunk.arguments_delta;
          accumulator.set(chunk.index, existing);
        } else if (chunk.type === 'finish') {
          finishReason = chunk.finish_reason;
        }
      }

      const toolCalls = Array.from(accumulator.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => tc);

      if (finishReason === 'tool_calls' && toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        } as ToolCallMessage);

        for (const tc of toolCalls) {
          toolCallCount++;
          if (!SUBAGENT_TOOL_NAMES.has(tc.name)) {
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: tool "${tc.name}" is not available to sub-agents (read-only tools only).`,
            });
            continue;
          }
          let result;
          try {
            result = await executeToolCall(tc.name, tc.arguments, cwd);
          } catch (err) {
            result = { success: false, output: '', error: err instanceof Error ? err.message : String(err) };
          }
          const content = result.success ? result.output : (result.error ?? 'Tool failed');
          messages.push({ role: 'tool', tool_call_id: tc.id, content });
        }

        iteration++;
        continue;
      }

      // stop or length — sub-agent is done
      finalText = assistantText;
      break;
    }

    if (iteration >= MAX_SUBAGENT_ITERATIONS && !finalText) {
      return {
        success: false,
        output: '',
        toolCallCount,
        iterations: iteration,
        error: 'Sub-agent exceeded max iterations without producing a final answer.',
      };
    }

    log.info('Subagent completed', { toolCallCount, iterations: iteration, outputLength: finalText.length });
    return {
      success: true,
      output: finalText || '(sub-agent returned no text)',
      toolCallCount,
      iterations: iteration,
    };
  } catch (err) {
    log.error('Subagent execution failed', { error: err instanceof Error ? err.message : String(err) });
    return {
      success: false,
      output: '',
      toolCallCount,
      iterations: iteration,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Module-level context (set once per main agent turn) ────────────────────
// Tools only receive `args: Record<string, unknown>` — they have no direct
// access to the provider/model configured for the current session. Mirrors
// the setTrustMode() pattern in process-tools-helpers.ts.

interface SubagentContext {
  provider: LLMProvider;
  model: string;
}

let activeContext: SubagentContext | null = null;

export function setSubagentContext(provider: LLMProvider, model: string): void {
  activeContext = { provider, model };
}

export function getSubagentContext(): SubagentContext | null {
  return activeContext;
}
