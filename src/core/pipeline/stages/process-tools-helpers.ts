// ── Tool Execution Helpers ──────────────────────────────────────────────────
// Extracted from src/core/tools/executor.ts — provides the confirm-or-skip
// flow for destructive tools and delegates to tool implementations.
//
// This is kept separate from the ProcessToolCallsStage so it can be tested
// independently and reused if needed.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { ToolResult } from '../../../types.js';
import { getToolByName } from '../../tools/registry.js';
import { confirmEdit, applyEdit } from '../../../utils/confirm.js';

// ── Module-level "yes for all" state ──────────────────────────────────────

let yesAllSessionActive = false;

export function resetYesAll(): void {
  yesAllSessionActive = false;
}

export function isYesAllActive(): boolean {
  return yesAllSessionActive;
}

// ── Confirm helper ─────────────────────────────────────────────────────────

async function confirmOrSkip(
  filePath: string,
  newContent: string,
  preReadOriginal?: string,
): Promise<{ accepted: boolean; originalContent: string }> {
  if (yesAllSessionActive) {
    const absPath = resolve(filePath);
    const original = preReadOriginal !== undefined
      ? preReadOriginal
      : (existsSync(absPath) ? await readFile(absPath, 'utf-8') : '');
    return { accepted: true, originalContent: original };
  }

  const { choice, originalContent } = await confirmEdit(filePath, newContent, preReadOriginal);
  if (choice === 'yes_all_session') {
    yesAllSessionActive = true;
  }
  return { accepted: choice === 'yes' || choice === 'yes_all_session', originalContent };
}

// ── Main execution ─────────────────────────────────────────────────────────

export async function executeToolCall(
  name: string,
  argsJson: string,
  cwd?: string,
): Promise<ToolResult> {
  const tool = getToolByName(name);
  if (!tool) {
    return { success: false, output: '', error: `Unknown tool: ${name}` };
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return { success: false, output: '', error: `Invalid JSON arguments for tool ${name}: ${argsJson}` };
  }

  // Validate required parameters
  const requiredParams: Record<string, string[]> = {
    read_file: ['path'],
    write_file: ['path', 'content'],
    edit_file: ['path', 'old_string', 'new_string'],
    execute_shell: ['command'],
    search_files: ['pattern'],
  };
  const required = requiredParams[name];
  if (required) {
    for (const p of required) {
      if (args[p] === undefined || args[p] === null) {
        return { success: false, output: '', error: `Missing required parameter "${p}" for tool ${name}` };
      }
    }
  }

  // ── Confirm flow for destructive operations ────────────────────────────
  if (name === 'edit_file') {
    const filePath = resolve(args.path as string);
    const oldString = args.old_string as string;
    const newString = args.new_string as string;

    const original = existsSync(filePath) ? await readFile(filePath, 'utf-8') : '';
    const preview = applyEdit(original, oldString, newString);
    if (preview === null) {
      return { success: false, output: '', error: `old_string not found in ${filePath}.` };
    }
    if (preview === 'AMBIGUOUS') {
      return { success: false, output: '', error: `old_string appears more than once in ${filePath}. Provide more surrounding context to make it unique.` };
    }

    const confirmStart = Date.now();
    const { accepted } = await confirmOrSkip(filePath, preview, original);
    const confirmDurationMs = Date.now() - confirmStart;
    if (!accepted) {
      return { success: false, output: '', error: 'Edit rejected by user.', userRejected: true, confirmDurationMs };
    }
    args._originalContent = original;
    args._confirmDurationMs = confirmDurationMs;
  } else if (name === 'write_file') {
    const filePath = resolve(args.path as string);
    const content = args.content as string;

    const confirmStart = Date.now();
    const { accepted, originalContent } = await confirmOrSkip(filePath, content);
    const confirmDurationMs = Date.now() - confirmStart;
    if (!accepted) {
      return { success: false, output: '', error: 'Write rejected by user.', userRejected: true, confirmDurationMs };
    }
    args._originalContent = originalContent;
    args._confirmDurationMs = confirmDurationMs;
  }

  // Inject cwd into execute_shell if not provided
  if (name === 'execute_shell' && cwd && !args.cwd) {
    args.cwd = cwd;
  }

  try {
    return await tool.execute(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: `Tool ${name} threw an error: ${message}` };
  }
}
