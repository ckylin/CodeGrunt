import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { ToolResult } from '../../types.js';
import { confirmEdit, confirmShellCommand, applyEdit, type ConfirmChoice } from '../../utils/confirm.js';
import { isDangerousWritePath, isDangerousShellCommand } from '../../utils/danger.js';
import type { PermissionAction } from '../permissions/index.js';
import { resolveToCwd } from '../tools/path-utils.js';
import { policyState } from './state.js';

// ── Strategy interface ─────────────────────────────────────────────────────
// Each destructive tool has one strategy that previews the change, asks the
// user (or skips the prompt per trust mode / permissions), and either lets the
// call proceed with extra args or ends it with a result.

export interface ConfirmContext {
  args: Record<string, unknown>;
  cwd?: string;
  permission: PermissionAction | null;
}

export type ConfirmOutcome =
  | { proceed: true; patch: Record<string, unknown> }
  | { proceed: false; result: ToolResult };

export type ConfirmStrategy = (ctx: ConfirmContext) => Promise<ConfirmOutcome>;

const strategies = new Map<string, ConfirmStrategy>();

export function registerConfirmStrategy(toolName: string, strategy: ConfirmStrategy): void {
  strategies.set(toolName, strategy);
}

export function getConfirmStrategy(toolName: string): ConfirmStrategy | undefined {
  return strategies.get(toolName);
}

// ── Prompt-or-skip core ────────────────────────────────────────────────────
// A dangerous operation always gets a real prompt: 'allow' and yes-for-all /
// auto are both overridden. Otherwise 'allow' skips the prompt, and 'ask'
// forces one even when yes-for-all is active.

function skipsPrompt(dangerous: boolean, permission: PermissionAction | null): boolean {
  return !dangerous && (permission === 'allow' || (policyState.yesAll && permission !== 'ask'));
}

function rememberYesAll(choice: ConfirmChoice, dangerous: boolean, permission: PermissionAction | null): void {
  if (choice === 'yes_all_session' && permission !== 'ask' && !dangerous) policyState.yesAll = true;
}

const isYes = (choice: ConfirmChoice): boolean => choice === 'yes' || choice === 'yes_all_session';

async function confirmFileChange(
  filePath: string,
  newContent: string,
  preRead: string | undefined,
  permission: PermissionAction | null,
  projectRoot: string,
): Promise<{ accepted: boolean; originalContent: string }> {
  const dangerous = isDangerousWritePath(filePath, projectRoot);

  if (skipsPrompt(dangerous, permission)) {
    const abs = resolve(filePath);
    const original = preRead !== undefined ? preRead : existsSync(abs) ? await readFile(abs, 'utf-8') : '';
    return { accepted: true, originalContent: original };
  }

  const { choice, originalContent } = await confirmEdit(filePath, newContent, preRead, projectRoot);
  rememberYesAll(choice, dangerous, permission);
  return { accepted: isYes(choice), originalContent };
}

async function confirmShell(command: string, cwd: string, permission: PermissionAction | null): Promise<boolean> {
  const dangerous = isDangerousShellCommand(command);
  if (skipsPrompt(dangerous, permission)) return true;

  const choice = await confirmShellCommand(command, cwd);
  rememberYesAll(choice, dangerous, permission);
  return isYes(choice);
}

const fail = (error: string): ConfirmOutcome => ({ proceed: false, result: { success: false, output: '', error } });

const rejected = (error: string, confirmDurationMs: number): ConfirmOutcome => ({
  proceed: false,
  result: { success: false, output: '', error, userRejected: true, confirmDurationMs },
});

// ── Built-in strategies ────────────────────────────────────────────────────

registerConfirmStrategy('edit_file', async ({ args, cwd, permission }) => {
  const filePath = resolveToCwd(args.path as string, cwd);
  const original = existsSync(filePath) ? await readFile(filePath, 'utf-8') : '';
  const preview = applyEdit(original, args.old_string as string, args.new_string as string);
  if (preview === null) return fail(`old_string not found in ${filePath}.`);
  if (preview === 'AMBIGUOUS') {
    return fail(`old_string appears more than once in ${filePath}. Provide more surrounding context to make it unique.`);
  }

  const started = Date.now();
  const { accepted } = await confirmFileChange(filePath, preview, original, permission, cwd ?? process.cwd());
  const confirmDurationMs = Date.now() - started;
  if (!accepted) return rejected('Edit rejected by user.', confirmDurationMs);
  return { proceed: true, patch: { _originalContent: original, _confirmDurationMs: confirmDurationMs } };
});

registerConfirmStrategy('write_file', async ({ args, cwd, permission }) => {
  const filePath = resolveToCwd(args.path as string, cwd);
  const started = Date.now();
  const { accepted, originalContent } = await confirmFileChange(
    filePath, args.content as string, undefined, permission, cwd ?? process.cwd(),
  );
  const confirmDurationMs = Date.now() - started;
  if (!accepted) return rejected('Write rejected by user.', confirmDurationMs);
  return { proceed: true, patch: { _originalContent: originalContent, _confirmDurationMs: confirmDurationMs } };
});

registerConfirmStrategy('execute_shell', async ({ args, cwd, permission }) => {
  const effectiveCwd = (args.cwd as string | undefined) ?? cwd ?? process.cwd();
  const started = Date.now();
  const accepted = await confirmShell(args.command as string, effectiveCwd, permission);
  const confirmDurationMs = Date.now() - started;
  if (!accepted) return rejected('Command rejected by user.', confirmDurationMs);
  return { proceed: true, patch: { _confirmDurationMs: confirmDurationMs } };
});
