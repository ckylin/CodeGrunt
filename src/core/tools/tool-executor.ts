import type { ToolResult } from '../../types.js';
import { ToolError } from '../errors.js';
import { getLogger } from '../observability/logger.js';
import { getToolPermission } from '../permissions/index.js';
import { runGates } from '../policy/gates.js';
import { getConfirmStrategy } from '../policy/confirm.js';
import { policyState } from '../policy/state.js';
import { repairToolArgs, getToolSchema } from './args-repair.js';
import { getToolByName } from './registry.js';

const fail = (error: string): ToolResult => ({ success: false, output: '', error });

/**
 * Run one tool call end to end: repair arguments, apply the policy gates
 * (required params, workspace deny, plan mode), ask for confirmation when the
 * tool has a confirm strategy, then execute.
 */
export async function executeToolCall(
  name: string,
  argsJson: string,
  cwd?: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const tool = getToolByName(name);
  if (!tool) return fail(`Unknown tool: ${name}`);

  const args = repairToolArgs(argsJson, name);
  if (args === null) {
    return fail(`Could not parse tool arguments for ${name}: ${argsJson.slice(0, 200)}`);
  }

  const permission = getToolPermission(policyState.permissions, name);

  const blocked = runGates({
    name,
    args,
    required: getToolSchema(name)?.required ?? [],
    destructive: tool.meta?.destructive === true,
    permission,
  });
  if (blocked) return blocked;

  const strategy = getConfirmStrategy(name);
  if (strategy) {
    const outcome = await strategy({ args, cwd, permission });
    if (!outcome.proceed) return outcome.result;
    Object.assign(args, outcome.patch);
  }

  try {
    return await tool.execute(args, { signal, cwd });
  } catch (err) {
    // Wrapped as ToolError for logging/crash-report purposes only. The pipeline
    // must keep receiving a graceful ToolResult (not a thrown error) so the
    // failure is reported back to the model instead of aborting the whole turn.
    const toolError = new ToolError(name, err instanceof Error ? err.message : String(err), err instanceof Error ? err : undefined);
    getLogger('tool-exec').error(`Tool ${name} threw an error`, { error: toolError.message, stack: toolError.stack });
    return fail(`Tool ${name} threw an error: ${toolError.message}`);
  }
}
