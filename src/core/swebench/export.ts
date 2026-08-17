// ── SWE-bench Prediction Export ───────────────────────────────────────────
// Exports the current working-tree diff as a SWE-bench-format JSONL prediction
// entry: { instance_id, model_patch, model_name_or_path }.
//
// The diff is taken against the repo's real HEAD (git diff HEAD), which
// captures both staged and unstaged changes made during the session. This
// does not touch the side-git snapshot repo in src/core/snapshot — that one
// tracks per-turn commits on a separate branch and isn't a source of a
// single cumulative diff without walking commit history.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { appendFile } from 'fs/promises';
import { join } from 'path';
import { getLogger } from '../observability/logger.js';

const execFileAsync = promisify(execFile);
const log = getLogger('swebench');

export interface SwebenchExportOptions {
  cwd: string;
  instanceId: string;
  modelName: string;
  outputPath?: string;
}

export interface SwebenchExportResult {
  outputPath: string;
  patchLength: number;
}

/** Get the unified diff of the working tree against HEAD (staged + unstaged). */
async function getWorkingTreeDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], { cwd });
    return stdout;
  } catch (err) {
    throw new Error(`Failed to compute git diff: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Export a SWE-bench-format prediction entry for the current session's changes.
 * Appends a single JSONL line to outputPath (defaults to <cwd>/swebench_predictions.jsonl).
 */
export async function exportSwebenchPrediction(
  options: SwebenchExportOptions,
): Promise<SwebenchExportResult> {
  const { cwd, instanceId, modelName } = options;
  const outputPath = options.outputPath ?? join(cwd, 'swebench_predictions.jsonl');

  const modelPatch = await getWorkingTreeDiff(cwd);

  const entry = {
    instance_id: instanceId,
    model_patch: modelPatch,
    model_name_or_path: modelName,
  };

  await appendFile(outputPath, JSON.stringify(entry) + '\n', 'utf-8');
  log.info('SWE-bench prediction exported', { instanceId, outputPath, patchLength: modelPatch.length });

  return { outputPath, patchLength: modelPatch.length };
}
