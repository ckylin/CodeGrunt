// ── Tool Execution Helpers ──────────────────────────────────────────────────
// Extracted from src/core/tools/executor.ts — provides the confirm-or-skip
// flow for destructive tools and delegates to tool implementations.
//
// This file also implements tool-call JSON repair: when the model emits
// malformed JSON arguments, repairToolArgs() attempts to salvage a usable
// object before giving up. This preserves the message prefix (no retry turn)
// and avoids a cache-busting round-trip.
//
// v0.6: Schema-aware repair — validates parameter names, types, required fields
// against the tool definition schema.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { ToolResult } from '../../../types.js';
import { getToolByName } from '../../tools/registry.js';
import { confirmEdit, confirmShellCommand, applyEdit } from '../../../utils/confirm.js';
import { isDangerousWritePath, isDangerousShellCommand } from '../../../utils/danger.js';
import { getToolPermission, type WorkspacePermissions, type PermissionAction } from '../../permissions/index.js';

// ── Tool-call JSON repair (v0.6: schema-aware) ─────────────────────────────
//
// DeepSeek (especially R1) occasionally emits malformed JSON in tool arguments:
// truncated strings, trailing commas, unquoted keys, or markdown fences.
// Rather than failing the entire turn and forcing a cache-busting retry,
// we attempt progressively more aggressive salvage strategies.
//
// v0.6 upgrade: Schema-aware validation detects:
//  - Illegal parameter names (not in the tool's schema)
//  - Type mismatches (e.g., string instead of number)
//  - Missing required parameters

import { getToolRegistry } from '../../tools/registry.js';

// Built-in tool schemas (fallback when registry is not available)
const BUILTIN_TOOL_SCHEMAS: Record<string, {
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required: string[];
}> = {
  read_file: {
    properties: {
      path: { type: 'string', description: 'The path to the file to read' },
      start_line: { type: 'number', description: 'First line to read (1-indexed)' },
      end_line: { type: 'number', description: 'Last line to read (1-indexed)' },
    },
    required: ['path'],
  },
  write_file: {
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  edit_file: {
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      old_string: { type: 'string', description: 'Text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute_shell: {
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
    },
    required: ['command'],
  },
  list_directory: {
    properties: {
      path: { type: 'string', description: 'Directory path to list' },
      depth: { type: 'number', description: 'Maximum recursion depth' },
    },
    required: ['path'],
  },
  search_files: {
    properties: {
      pattern: { type: 'string', description: 'Search pattern' },
      path: { type: 'string', description: 'Directory to search in' },
      file_pattern: { type: 'string', description: 'Glob-like file extension filter' },
      is_regex: { type: 'boolean', description: 'Treat pattern as regex' },
    },
    required: ['pattern'],
  },
  web_search: {
    properties: {
      query: { type: 'string', description: 'Search query' },
      num_results: { type: 'number', description: 'Number of results' },
    },
    required: ['query'],
  },
  code_search: {
    properties: {
      query: { type: 'string', description: 'Symbol name or partial name' },
      kind: { type: 'string', description: 'Filter by symbol kind' },
      max_results: { type: 'number', description: 'Maximum number of results' },
    },
    required: ['query'],
  },
  agent_open: {
    properties: {
      task: { type: 'string', description: 'Task for the sub-agent' },
    },
    required: ['task'],
  },
  memory_write: {
    properties: {
      name: { type: 'string', description: 'Identifier for the memory entry' },
      type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Entry type' },
      description: { type: 'string', description: 'One-line summary' },
      body: { type: 'string', description: 'Content to store' },
    },
    required: ['name', 'type', 'description', 'body'],
  },
  memory_read: {
    properties: {
      type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Filter by type' },
    },
    required: [],
  },
};

/**
 * Get the schema for a given tool name.
 * First tries the tool registry, then falls back to built-in schemas.
 */
function getToolSchema(toolName: string): { properties: Record<string, { type: string; description?: string; enum?: string[] }>; required: string[] } | null {
  try {
    const registry = getToolRegistry();
    const tool = registry.getByName(toolName);
    if (tool) {
      const params = tool.definition.function.parameters as Record<string, unknown> | undefined;
      if (params && typeof params === 'object') {
        const properties = (params.properties as Record<string, { type: string; description?: string; enum?: string[] }>) ?? {};
        const required = (params.required as string[]) ?? [];
        return { properties, required };
      }
    }
  } catch {
    // Registry not available — fall through
  }
  return BUILTIN_TOOL_SCHEMAS[toolName] ?? null;
}

/**
 * Parse argsJson with fallback repair strategies.
 * Returns parsed object on success, null if all strategies fail.
 */
function parseJsonWithFallback(argsJson: string): Record<string, unknown> | null {
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

    // Strategy 4: fix trailing commas and unquoted keys
    const fixed = braceMatch[0]
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
    try {
      return JSON.parse(fixed) as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  return null;
}

/**
 * Schema-aware tool argument repair (v0.6).
 *
 * In addition to JSON format repair, this function:
 * 1. Parses the arguments JSON
 * 2. Validates parameter names against the tool's schema
 * 3. Detects and fixes parameter name typos
 * 4. Validates types (auto-converts number/boolean strings)
 * 5. Checks for missing required parameters
 *
 * @param argsJson Raw JSON string from the model
 * @param toolName Tool name for schema-aware validation (optional)
 * @returns Parsed and repaired arguments, or null if all strategies fail
 */
export function repairToolArgs(argsJson: string, toolName?: string): Record<string, unknown> | null {
  const parsed = parseJsonWithFallback(argsJson);
  if (!parsed) return null;

  // Backward-compatible: no schema validation without tool name
  if (!toolName) return parsed;

  const schema = getToolSchema(toolName);
  if (!schema) return parsed;

  // ── Schema validation ────────────────────────────────────────────────
  const schemaKeys = new Set(Object.keys(schema.properties));

  // 1. Check for unknown parameters — auto-fix with fuzzy matching
  for (const key of Object.keys(parsed)) {
    if (!schemaKeys.has(key)) {
      const closest = findClosestKey(key, schemaKeys);
      if (closest) {
        parsed[closest] = parsed[key];
        delete parsed[key];
      } else {
        delete parsed[key];
      }
    }
  }

  // 2. Check types — auto-convert where possible
  for (const [key, value] of Object.entries(parsed)) {
    const prop = schema.properties[key];
    if (!prop || value === null || value === undefined) continue;

    const expectedType = prop.type;
    const actualType = typeof value;

    // Number from string
    if (expectedType === 'number' && actualType === 'string') {
      const num = Number(value);
      if (!isNaN(num)) parsed[key] = num;
    }
    // String from number
    else if (expectedType === 'string' && actualType === 'number') {
      parsed[key] = String(value);
    }
    // Boolean from string
    else if (expectedType === 'boolean' && actualType === 'string') {
      const lower = (value as string).toLowerCase();
      if (lower === 'true' || lower === 'yes') parsed[key] = true;
      else if (lower === 'false' || lower === 'no') parsed[key] = false;
    }
    // Enum value check
    else if (prop.enum && typeof value === 'string') {
      if (!prop.enum.includes(value as string)) {
        const match = prop.enum.find(e => e.toLowerCase() === (value as string).toLowerCase());
        if (match) parsed[key] = match;
        else parsed[key] = prop.enum[0];
      }
    }
  }

  return parsed;
}

/**
 * Find the closest matching key from a set of valid keys.
 * Checks: case-insensitive exact → prefix → character overlap ≥ 60%.
 */
function findClosestKey(input: string, validKeys: Set<string>): string | null {
  const lowerInput = input.toLowerCase();

  // Case-insensitive exact match
  for (const key of validKeys) {
    if (key.toLowerCase() === lowerInput) return key;
  }

  // Prefix match (handles underscore/no-underscore typos)
  const prefixMatches: Array<{ key: string; score: number }> = [];
  for (const key of validKeys) {
    const lowerKey = key.toLowerCase();
    const inputNorm = lowerInput.replace(/[_-]/g, '');
    const keyNorm = lowerKey.replace(/[_-]/g, '');
    if (keyNorm.startsWith(inputNorm)) {
      prefixMatches.push({ key, score: inputNorm.length / keyNorm.length });
    }
  }
  if (prefixMatches.length > 0) {
    prefixMatches.sort((a, b) => b.score - a.score);
    return prefixMatches[0].key;
  }

  // Character overlap ≥ 60%
  const overlapMatches: Array<{ key: string; score: number }> = [];
  for (const key of validKeys) {
    const lowerKey = key.toLowerCase();
    const inputChars = new Set(lowerInput.replace(/[_-]/g, ''));
    const keyChars = new Set(lowerKey.replace(/[_-]/g, ''));
    const intersection = new Set([...inputChars].filter(c => keyChars.has(c)));
    const score = intersection.size / Math.max(inputChars.size, keyChars.size);
    if (score >= 0.6) overlapMatches.push({ key, score });
  }
  if (overlapMatches.length > 0) {
    overlapMatches.sort((a, b) => b.score - a.score);
    return overlapMatches[0].key;
  }

  return null;
}

// ── Module-level "yes for all" state ──────────────────────────────────────

let yesAllSessionActive = false;
let currentTrustMode: 'plan' | 'code' | 'auto' = 'code';
let currentPermissions: WorkspacePermissions | null = null;

/** Set the active workspace permissions (.codegrunt/permissions.json). Called once per turn. */
export function setWorkspacePermissions(permissions: WorkspacePermissions | null): void {
  currentPermissions = permissions;
}

export function getWorkspacePermissions(): WorkspacePermissions | null {
  return currentPermissions;
}

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
  permAction?: PermissionAction | null,
  projectRoot: string = process.cwd(),
): Promise<{ accepted: boolean; originalContent: string }> {
  // Dangerous writes (sensitive dirs, escaping the project root) always get
  // a real confirm prompt — 'allow' permission and yes-for-all/auto trust
  // mode are both overridden, matching the intent of workspace permission
  // 'ask' (which already bypasses yes-for-all further down).
  const dangerous = isDangerousWritePath(filePath, projectRoot);

  // permission 'allow' always skips the prompt; 'ask' always forces one even in auto mode
  if (!dangerous && (permAction === 'allow' || (yesAllSessionActive && permAction !== 'ask'))) {
    const absPath = resolve(filePath);
    const original = preReadOriginal !== undefined
      ? preReadOriginal
      : (existsSync(absPath) ? await readFile(absPath, 'utf-8') : '');
    return { accepted: true, originalContent: original };
  }

  const { choice, originalContent } = await confirmEdit(filePath, newContent, preReadOriginal, projectRoot);
  // Dangerous prompts never offer "yes for all" (see confirm.ts promptConfirm),
  // so this branch is unreachable for them — kept for the non-dangerous path.
  if (choice === 'yes_all_session' && permAction !== 'ask' && !dangerous) {
    yesAllSessionActive = true;
  }
  return { accepted: choice === 'yes' || choice === 'yes_all_session', originalContent };
}

/** Same confirm-or-skip flow as confirmOrSkip, but for shell commands (no file/diff). */
async function confirmShellOrSkip(
  command: string,
  effectiveCwd: string,
  permAction?: PermissionAction | null,
): Promise<boolean> {
  const dangerous = isDangerousShellCommand(command);

  if (!dangerous && (permAction === 'allow' || (yesAllSessionActive && permAction !== 'ask'))) return true;

  const choice = await confirmShellCommand(command, effectiveCwd);
  if (choice === 'yes_all_session' && permAction !== 'ask' && !dangerous) {
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
  // v0.6: Pass tool name for schema-aware repair
  const parsed = repairToolArgs(argsJson, name);
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

  const permAction = getToolPermission(currentPermissions, name);

  // ── Workspace permissions: hard deny takes precedence over everything ──
  if (permAction === 'deny') {
    return {
      success: false,
      output: '',
      error: `[permissions] Tool "${name}" is denied by .codegrunt/permissions.json.`,
      userRejected: true,
    };
  }

  // ── Plan mode: block all destructive operations ───────────────────────
  const DESTRUCTIVE_TOOLS = new Set(['write_file', 'edit_file', 'execute_shell']);
  if (currentTrustMode === 'plan' && DESTRUCTIVE_TOOLS.has(name) && permAction !== 'allow') {
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
    const { accepted } = await confirmOrSkip(filePath, preview, original, permAction, cwd ?? process.cwd());
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
    const { accepted, originalContent } = await confirmOrSkip(filePath, content, undefined, permAction, cwd ?? process.cwd());
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
  // through the same confirm-or-skip gate as write_file/edit_file
  if (name === 'execute_shell') {
    const command = args.command as string;
    const effectiveCwd = (args.cwd as string | undefined) ?? cwd ?? process.cwd();
    const confirmStart = Date.now();
    const accepted = await confirmShellOrSkip(command, effectiveCwd, permAction);
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
