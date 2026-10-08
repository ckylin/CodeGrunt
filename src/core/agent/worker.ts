// ── Orchestrator Worker (general-purpose, extends subagent.ts) ─────────────
// A thin wrapper around runSubagent() that lets the Orchestrator grant a
// wider tool allowlist than the read-only default — specifically write_file
// and edit_file for coding sub-tasks that the Planner marked parallelizable.
//
// execute_shell is intentionally never included here (see orchestrator.ts /
// the architecture plan): concurrent shell execution risks both filesystem
// races between workers and confirm-dialog stdin/stdout contention.
//
// All lifecycle management (timeout, abort-signal combination, caching,
// model downgrade policy) is inherited unchanged from runSubagent — this
// file adds exactly one new capability (tool allowlist override) and nothing
// else, to avoid duplicating subagent.ts's logic.

import { runSubagent, getSubagentToolNames, type SubagentRunOptions, type SubagentResult } from './subagent.js';
import { toolNamesWithTrait } from '../tools/registry.js';

/** Tools an Orchestrator-dispatched coding worker may use in addition to the read-only default (file writers; never shell). */
export function getWorkerWriteToolNames(): Set<string> {
  return toolNamesWithTrait('writesFiles');
}

/** Read-only sub-agent tools plus file writers: the allowlist for a worker that may write. */
export function getWriterAllowlist(): Set<string> {
  return new Set([...getSubagentToolNames(), ...getWorkerWriteToolNames()]);
}

export interface WorkerRunOptions extends Omit<SubagentRunOptions, '_allowedTools'> {
  /**
   * When true, grants write_file/edit_file access on top of the read-only
   * default tool set. Use only for steps the Planner marked parallelizable
   * with non-overlapping targetFiles — the caller is responsible for that
   * conflict check, not this function.
   */
  allowWrite?: boolean;
}

/**
 * Run a single Orchestrator worker to completion. Identical to runSubagent()
 * except it may grant write_file/edit_file when allowWrite is set.
 */
export async function runWorker(options: WorkerRunOptions): Promise<SubagentResult> {
  const { allowWrite, ...rest } = options;
  const allowedTools = allowWrite ? getWriterAllowlist() : undefined;

  return runSubagent({
    ...rest,
    _allowedTools: allowedTools,
  });
}
