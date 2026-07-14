// ── agent_open Tool ──────────────────────────────────────────────────────────
// Spawns a read-only research sub-agent for a focused sub-task and blocks
// until it returns a final answer. Useful for parallel-izable investigation
// (e.g. "check how auth is implemented" while the main agent keeps working
// on the primary file) without bloating the main context with intermediate
// tool calls the caller doesn't need to see in full.
//
// v1 is synchronous: one call = one sub-agent, run to completion, no
// backgrounding. See src/core/agent/subagent.ts for the execution loop.

import type { Tool, ToolResult } from '../../types.js';
import { runSubagent, getSubagentContext } from '../agent/subagent.js';
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
        'without filling your own context with the intermediate reads. Returns the sub-agent\'s final answer as text.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A clear, self-contained research question or investigation task for the sub-agent. Include enough context — the sub-agent starts with no knowledge of the current conversation.',
          },
        },
        required: ['task'],
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    const task = args.task as string;
    const cwd = (args.cwd as string | undefined) ?? process.cwd();

    const ctx = getSubagentContext();
    if (!ctx) {
      return {
        success: false,
        output: '',
        error: 'agent_open is unavailable: no active provider/model context (this should not happen — file a bug).',
      };
    }

    log.info('Spawning sub-agent', { task: task.slice(0, 100) });

    const result = await runSubagent({
      task,
      cwd,
      provider: ctx.provider,
      model: ctx.model,
    });

    if (!result.success) {
      return { success: false, output: '', error: result.error ?? 'Sub-agent failed' };
    }

    return {
      success: true,
      output: result.output,
    };
  },
};
