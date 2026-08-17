// ── agent_open Tool (v0.7: Concurrent + Caching + Model Strategy) ──────────
// Spawns a read-only research sub-agent for a focused sub-task and blocks
// until it returns a final answer. Useful for parallel-izable investigation
// (e.g. "check how auth is implemented" while the main agent keeps working
// on the primary file) without bloating the main context with intermediate
// tool calls the caller doesn't need to see in full.
//
// v0.7 upgrades:
//   - Concurrency: accepts `concurrency: true` or multiple tasks in a batch
//   - Model strategy: accepts `model` override for sub-agent
//   - Result caching: accepts `use_cache: true` to skip redundant execution
//   - Timeout: accepts `timeout_ms` for per-agent timeout
//
// v1 is synchronous: one call = one sub-agent, run to completion.

import type { Tool, ToolResult } from '../../types.js';
import { runSubagent, runSubagentsConcurrent, getSubagentContext } from '../agent/subagent.js';
import { getLogger } from '../observability/logger.js';

const log = getLogger('tools:agent_open');

export const agentOpenTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'agent_open',
      description:
        'Delegate a focused, read-only research question to an isolated sub-agent and wait for its answer. ' +
        'The sub-agent has its own context and can use read_file, search_files, list_directory, code_search, ' +
        'web_search, and memory_read — but NOT write_file, edit_file, or execute_shell. ' +
        'Use this to investigate a sub-question (e.g. "how is authentication implemented in this repo?") ' +
        'without filling your own context with the intermediate reads. Returns the sub-agent\'s final answer as text.\n\n' +
        'For parallel investigation, set "concurrency": true and pass an array of tasks in the "tasks" field. ' +
        'Results will be returned as an array of answers.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A clear, self-contained research question or investigation task for the sub-agent. Include enough context — the sub-agent starts with no knowledge of the current conversation.',
          },
          tasks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of tasks for concurrent execution (when concurrency is true). Each task will be run in a separate sub-agent.',
          },
          concurrency: {
            type: 'boolean',
            description: 'When true, run multiple tasks concurrently. Pass tasks as an array in the "tasks" field. Default: false.',
          },
          model: {
            type: 'string',
            description: 'Optional model override for the sub-agent. Defaults to flash (cheapest tier). Set to "inherit" to use the parent agent\'s model.',
          },
          use_cache: {
            type: 'boolean',
            description: 'When true, cache results by input hash to avoid redundant execution of identical tasks. Default: false.',
          },
          timeout_ms: {
            type: 'number',
            description: 'Per-agent timeout in milliseconds. Default: 120000 (120s).',
          },
        },
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    const cwd = (args.cwd as string | undefined) ?? process.cwd();
    const concurrency = args.concurrency === true;
    const useCache = args.use_cache === true;
    const timeoutMs = args.timeout_ms as number | undefined;
    const modelOverride = args.model as string | undefined;

    const ctx = getSubagentContext();
    if (!ctx) {
      return {
        success: false,
        output: '',
        error: 'agent_open is unavailable: no active provider/model context (this should not happen — file a bug).',
      };
    }

    // Resolve model strategy. When the caller explicitly names a model (including
    // "inherit"), that choice must stick — runSubagent's default flash-downgrade
    // policy only applies when no override was requested at all.
    const model = modelOverride === 'inherit' ? ctx.model : (modelOverride ?? ctx.model);
    const noModelDowngrade = modelOverride !== undefined;

    // ── Concurrent mode ──────────────────────────────────────────────────
    if (concurrency) {
      const taskList = args.tasks as string[] | undefined;
      if (!taskList || !Array.isArray(taskList) || taskList.length === 0) {
        return {
          success: false,
          output: '',
          error: 'Concurrent mode requires a "tasks" array with at least one task string.',
        };
      }

      log.info('Spawning concurrent sub-agents', { taskCount: taskList.length, model });

      try {
        const result = await runSubagentsConcurrent({
          tasks: taskList.map(task => ({
            task,
            cwd,
            provider: ctx.provider,
            model,
            useCache,
            timeoutMs,
            noModelDowngrade,
          })),
          allowPartialFailure: true,
        });

        // Format results
        const outputLines = result.results.map((r, i) => {
          const header = `[Task ${i + 1}/${result.results.length}]`;
          if (r.success) {
            return `${header} (${r.durationMs}ms, ${r.toolCallCount} tools, ${r.iterations} iters)\n${r.output}`;
          }
          return `${header} FAILED: ${r.error ?? 'Unknown error'}`;
        });

        const summary = `\n--- Concurrent Results (${result.succeeded}/${result.results.length} succeeded, ${result.totalTimeMs}ms total) ---\n\n`;

        return {
          success: result.succeeded > 0,
          output: summary + outputLines.join('\n\n'),
        };
      } catch (err) {
        return {
          success: false,
          output: '',
          error: `Concurrent sub-agents failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // ── Single sub-agent mode (original behavior) ────────────────────────
    const task = args.task as string;
    if (!task) {
      return {
        success: false,
        output: '',
        error: 'agent_open requires a "task" string or "concurrency: true" with a "tasks" array.',
      };
    }

    log.info('Spawning sub-agent', { task: task.slice(0, 100), model, useCache, timeoutMs });

    const result = await runSubagent({
      task,
      cwd,
      provider: ctx.provider,
      model,
      useCache,
      timeoutMs,
      noModelDowngrade,
    });

    if (!result.success) {
      return { success: false, output: '', error: result.error ?? 'Sub-agent failed' };
    }

    const perfInfo = result.durationMs != null
      ? `\n[sub-agent: ${result.durationMs}ms, ${result.toolCallCount} tool calls, ${result.iterations} iterations]`
      : '';

    return {
      success: true,
      output: result.output + perfInfo,
    };
  },
};
