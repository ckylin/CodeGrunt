// ── Tool Execution Helpers ──────────────────────────────────────────────────
// Extracted from src/core/tools/executor.ts — provides the confirm-or-skip
// flow for destructive tools and delegates to tool implementations.
//
// This file also implements tool-call JSON repair: when the model emits
// malformed JSON arguments, repairToolArgs() attempts to salvage a usable
// object before giving up. This preserves the message prefix (no retry turn)
// and avoids a cache-busting round-trip.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { ToolResult } from '../../../types.js';
import { getToolByName } from '../../tools/registry.js';
import { confirmEdit, confirmShellCommand, applyEdit } from '../../../utils/confirm.js';

// ── Tool-call JSON repair ─────────────────────────────────────────────────
//
// DeepSeek (especially R1) occasionally emits malformed JSON in tool arguments:
// truncated strings, trailing commas, unquoted keys, or markdown fences.
// Rather than failing the entire turn and forcing a cache-busting retry,
// we attempt progressively more aggressive salvage strategies.

/**
 * Attempt to parse argsJson, with fallback repair strategies:
 * 1. Standard JSON.parse
 * 2. Strip markdown code fences (```json ... ```)
 * 3. Extract the first {...} block via regex
 * 4. Replace common JSON mistakes: trailing commas, unquoted keys
 * Returns parsed object on success, null if all strategies fail.
 */
export function repairToolArgs(argsJson: string): Record<string, unknown> | null {
  // Strategy 1: standard parse
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch { /* fall through */ }

  let s = argsJson.trim();

  // Strategy 2: strip markdown fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch { /* fall through */ }

  // Strategy 3: extract first {...} block
  const braceMatch = s.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as Record<string, unknown>;
    } catch { /* fall through */ }

    // Strategy 4: fix trailing commas and unquoted keys in extracted block
    const fixed = braceMatch[0]
      .replace(/,\s*([}\]])/g, '$1')           // trailing commas
      .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');  // unquoted keys
    try {
      return JSON.parse(fixed) as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  return null;
}

// ── Module-level "yes for all" state ──────────────────────────────────────

let yesAllSessionActive = false;
let currentTrustMode: 'plan' | 'code' | 'auto' = 'code';

export function resetYesAll(): void {
  yesAllSessionActive = false;
}

export function isYesAllActive(): boolean {
  return yesAllSessionActive;
}

export function setTrustMode(mode: 'plan' | 'code' | 'auto'): void {
  currentTrustMode = mode;
  // auto mode is equivalent to yes-for-all
  if (mode === 'auto') yesAllSessionActive = true;
}

export function getTrustMode(): 'plan' | 'code' | 'auto' {
  return currentTrustMode;
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

/** Same confirm-or-skip flow as confirmOrSkip, but for shell commands (no file/diff). */
async function confirmShellOrSkip(command: string, effectiveCwd: string): Promise<boolean> {
  if (yesAllSessionActive) return true;

  const choice = await confirmShellCommand(command, effectiveCwd);
  if (choice === 'yes_all_session') {
    yesAllSessionActive = true;
  }
  return choice === 'yes' || choice === 'yes_all_session';
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
  const parsed = repairToolArgs(argsJson);
  if (parsed === null) {
    return { success: false, output: '', error: `Could not parse tool arguments for ${name}: ${argsJson.slice(0, 200)}` };
  }
  args = parsed;

  // Validate required parameters
  const requiredParams: Record<string, string[]> = {
    read_file: ['path'],
    write_file: ['path', 'content'],
    edit_file: ['path', 'old_string', 'new_string'],
    execute_shell: ['command'],
    search_files: ['pattern'],
    agent_open: ['task'],
  };
  const required = requiredParams[name];
  if (required) {
    for (const p of required) {
      if (args[p] === undefined || args[p] === null) {
        return { success: false, output: '', error: `Missing required parameter "${p}" for tool ${name}` };
      }
    }
  }

  // ── Plan mode: block all destructive operations ───────────────────────
  const DESTRUCTIVE_TOOLS = new Set(['write_file', 'edit_file', 'execute_shell']);
  if (currentTrustMode === 'plan' && DESTRUCTIVE_TOOLS.has(name)) {
    return {
      success: false,
      output: '',
      error: `[plan mode] Tool "${name}" is blocked in plan (read-only) mode. Switch to code or auto mode with /trust.`,
      userRejected: true,
    };
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

  // Inject cwd into execute_shell / agent_open if not provided
  if ((name === 'execute_shell' || name === 'agent_open') && cwd && !args.cwd) {
    args.cwd = cwd;
  }

  // execute_shell is destructive (arbitrary command execution) and must go
  // through the same confirm-or-skip gate as write_file/edit_file — it was
  // previously only blocked in plan mode, letting it run unconfirmed in the
  // default "code" trust mode.
  if (name === 'execute_shell') {
    const command = args.command as string;
    const effectiveCwd = (args.cwd as string | undefined) ?? cwd ?? process.cwd();
    const confirmStart = Date.now();
    const accepted = await confirmShellOrSkip(command, effectiveCwd);
    const confirmDurationMs = Date.now() - confirmStart;
    if (!accepted) {
      return { success: false, output: '', error: 'Command rejected by user.', userRejected: true, confirmDurationMs };
    }
    args._confirmDurationMs = confirmDurationMs;
  }

  try {
    return await tool.execute(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: `Tool ${name} threw an error: ${message}` };
  }
}
