// ── Sub-agent Execution (v0.7: Concurrent + Cache + Lifecycle) ──────────────
// Runs a focused, read-only research task in an isolated message context.
// Spawned by the main agent via the `agent_open` tool when a sub-question
// benefits from its own investigation loop (multi-file search, web lookup)
// without polluting the caller's context window.
//
// v0.7 upgrades:
//   - Non-blocking concurrent execution: multiple sub-agents in parallel
//   - Lifecycle management: timeout (120s), cancel propagation, partial failure
//   - Result caching: same inputs skip redundant execution
//   - Model strategy: configurable sub-agent model (default flash downgrade)
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
import { getSubagentCache, clearSubagentCache, getSubagentCacheStats } from './subagent-cache.js';

const log = getLogger('subagent');

const MAX_SUBAGENT_ITERATIONS = 10;
const SUBAGENT_MAX_TOKENS = 4096;
/** Default timeout for a single sub-agent (120s) */
const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;
/** Maximum concurrent sub-agents */
const MAX_CONCURRENT_SUBAGENTS = 10;

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
  /** Time elapsed (ms) */
  durationMs?: number;
}

export interface SubagentRunOptions {
  task: string;
  cwd: string;
  provider: LLMProvider;
  model: string;
  /** Replaces the default read-only research-agent system prompt (used by Skills v2 subagent mode). */
  systemOverride?: string;
  signal?: AbortSignal;
  /** Timeout in milliseconds (default: 120000) */
  timeoutMs?: number;
  /** When true, enables result caching by input hash (default: false) */
  useCache?: boolean;
  /** Explicitly disable the automatic flash model downgrade (default: false) */
  noModelDowngrade?: boolean;
}

export interface ConcurrentSubagentOptions {
  tasks: SubagentRunOptions[];
  /** Maximum concurrent sub-agents (default: 10) */
  concurrency?: number;
  /** Global timeout for all sub-agents to complete (default: 120000) */
  timeoutMs?: number;
  /** When true, partial failures are allowed — results contain both successes and failures */
  allowPartialFailure?: boolean;
  /** Signal shared across all sub-agents */
  signal?: AbortSignal;
}

export interface ConcurrentSubagentResult {
  results: SubagentResult[];
  totalTimeMs: number;
  succeeded: number;
  failed: number;
  timedOut: number;
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
function selectSubagentModel(configuredModel: string, noDowngrade?: boolean): string {
  if (noDowngrade) return configuredModel;
  if (configuredModel.startsWith('deepseek-')) return 'deepseek-v4-flash';
  return configuredModel;
}

/**
 * Run a single sub-agent turn-loop to completion.
 * Synchronous from the caller's perspective — this promise resolves only once
 * the sub-agent has produced a final text answer or given up.
 *
 * Supports:
 *   - Configurable timeout (default 120s)
 *   - Result caching (when useCache=true)
 *   - Model strategy (noModelDowngrade to keep parent model)
 */
export async function runSubagent(options: SubagentRunOptions): Promise<SubagentResult> {
  const { task, cwd, provider, signal } = options;
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  const model = selectSubagentModel(options.model, options.noModelDowngrade);
  const toolDefs = getSubagentToolDefinitions();

  // ── Cache check ──────────────────────────────────────────────────────────
  if (options.useCache) {
    const cache = getSubagentCache();
    const cacheKey = cache.hashKey(task, model, options.systemOverride, cwd);
    const cached = cache.get(cacheKey);
    if (cached) {
      log.info('Subagent cache hit', { task: task.slice(0, 60) });
      return { ...cached, durationMs: 0 };
    }
  }

  const messages: Message[] = [
    { role: 'system', content: options.systemOverride ?? buildSubagentSystemPrompt(cwd) },
    { role: 'user', content: task },
  ];

  let toolCallCount = 0;
  let iteration = 0;
  let finalText = '';

  // ── Timeout handling ───────────────────────────────────────────────────
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
    log.warn('Subagent timed out', { task: task.slice(0, 60), timeoutMs });
  }, timeoutMs);

  // Combine external signal with timeout signal
  const combined = signal ? combineAbortSignals(signal, timeoutController.signal) : null;
  const combinedSignal = combined ? combined.signal : timeoutController.signal;

  try {
    while (iteration < MAX_SUBAGENT_ITERATIONS) {
      if (combinedSignal.aborted) {
        const elapsed = Date.now() - startTime;
        const reason = timeoutController.signal.aborted ? 'timeout' : 'cancelled';
        return {
          success: false,
          output: finalText,
          toolCallCount,
          iterations: iteration,
          error: `Sub-agent ${reason} after ${elapsed}ms`,
          durationMs: elapsed,
        };
      }

      let assistantText = '';
      let finishReason: 'stop' | 'tool_calls' | 'length' | null = null;
      const accumulator = new Map<number, { id: string; name: string; arguments: string }>();

      const stream = provider.stream(messages, {
        model,
        maxTokens: SUBAGENT_MAX_TOKENS,
        temperature: 0.2,
        tools: toolDefs,
        signal: combinedSignal,
      });

      for await (const chunk of stream) {
        if (combinedSignal.aborted) break;
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
      const elapsed = Date.now() - startTime;
      return {
        success: false,
        output: '',
        toolCallCount,
        iterations: iteration,
        error: 'Sub-agent exceeded max iterations without producing a final answer.',
        durationMs: elapsed,
      };
    }

    const durationMs = Date.now() - startTime;
    log.info('Subagent completed', { toolCallCount, iterations: iteration, outputLength: finalText.length, durationMs });

    const result: SubagentResult = {
      success: true,
      output: finalText || '(sub-agent returned no text)',
      toolCallCount,
      iterations: iteration,
      durationMs,
    };

    // ── Cache store ──────────────────────────────────────────────────────
    if (options.useCache) {
      const cache = getSubagentCache();
      const cacheKey = cache.hashKey(task, model, options.systemOverride, cwd);
      cache.set(cacheKey, {
        success: result.success,
        output: result.output,
        toolCallCount: result.toolCallCount,
        iterations: result.iterations,
      });
    }

    return result;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    log.error('Subagent execution failed', { error: err instanceof Error ? err.message : String(err), elapsed });
    return {
      success: false,
      output: '',
      toolCallCount,
      iterations: iteration,
      error: err instanceof Error ? err.message : String(err),
      durationMs: elapsed,
    };
  } finally {
    clearTimeout(timeoutId);
    combined?.dispose();
  }
}

// ── Concurrent Sub-agent Execution (v0.7) ──────────────────────────────────
//
// Runs multiple sub-agents concurrently with:
//   - Configurable concurrency limit (default 10)
//   - Per-agent timeout (120s)
//   - Result caching
//   - Partial failure mode (allowPartialFailure)
//   - Shared abort signal

/**
 * Run multiple sub-agents concurrently, respecting the concurrency limit.
 * Results are aggregated into a ConcurrentSubagentResult.
 */
export async function runSubagentsConcurrent(
  options: ConcurrentSubagentOptions,
): Promise<ConcurrentSubagentResult> {
  const startTime = Date.now();
  const concurrency = Math.min(options.concurrency ?? MAX_CONCURRENT_SUBAGENTS, MAX_CONCURRENT_SUBAGENTS);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  const allowPartial = options.allowPartialFailure ?? false;
  const { tasks, signal } = options;

  const results: SubagentResult[] = new Array(tasks.length);
  let succeeded = 0;
  let failed = 0;
  let timedOut = 0;

  log.info('Starting concurrent sub-agents', { taskCount: tasks.length, concurrency, timeoutMs });

  // Process tasks in batches of `concurrency`
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map((taskOpts, batchIdx) =>
        runSubagent({
          ...taskOpts,
          signal: taskOpts.signal ?? signal,
          timeoutMs: taskOpts.timeoutMs ?? timeoutMs,
        }).then(result => ({ index: i + batchIdx, result })),
      ),
    );

    for (const settled of batchResults) {
      if (settled.status === 'fulfilled') {
        const { index, result } = settled.value;
        results[index] = result;
        if (result.success) {
          succeeded++;
        } else if (result.error?.includes('timeout')) {
          timedOut++;
          failed++;
        } else {
          failed++;
        }
      } else {
        // Promise rejected (shouldn't happen — runSubagent catches errors internally)
        const index = i + batchResults.indexOf(settled);
        results[index] = {
          success: false,
          output: '',
          toolCallCount: 0,
          iterations: 0,
          error: `Unexpected error: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`,
        };
        failed++;
      }
    }

    if (signal?.aborted) {
      // Fill remaining slots with aborted status
      for (let j = i + concurrency; j < tasks.length; j++) {
        results[j] = {
          success: false,
          output: '',
          toolCallCount: 0,
          iterations: 0,
          error: 'Aborted',
        };
        failed++;
      }
      break;
    }
  }

  const totalTimeMs = Date.now() - startTime;
  log.info('Concurrent sub-agents complete', {
    total: tasks.length,
    succeeded,
    failed,
    timedOut,
    totalTimeMs,
  });

  // If no partial failures allowed and any failed, throw
  if (!allowPartial && failed > 0) {
    const errors = results
      .filter(r => !r.success)
      .map(r => r.error)
      .filter(Boolean)
      .join('; ');
    throw new Error(`Concurrent sub-agents: ${failed}/${tasks.length} failed. Errors: ${errors}`);
  }

  return {
    results: results.filter(Boolean),
    totalTimeMs,
    succeeded,
    failed,
    timedOut,
  };
}

// ── Abort Signal Combiner ──────────────────────────────────────────────────
// Creates a single AbortSignal that aborts when ANY of the input signals abort.
// Cleans up listeners on abort to avoid leaks.

function combineAbortSignals(...signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return { signal: controller.signal, dispose: () => {} };
    }
  }

  // Track listeners so they can be detached once the caller is done with the
  // combined signal — otherwise, when a source signal (e.g. a shared per-turn
  // signal reused across many sub-agents) never aborts, the listener added
  // here would live for that source signal's entire lifetime.
  const teardowns: Array<() => void> = [];
  for (const signal of signals) {
    const listener = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
    teardowns.push(() => signal.removeEventListener('abort', listener));
  }

  return {
    signal: controller.signal,
    dispose: () => { for (const teardown of teardowns) teardown(); },
  };
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

// Re-export cache utilities
export { clearSubagentCache, getSubagentCacheStats };
