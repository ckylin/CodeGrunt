import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';
import { selectFromList } from './select.js';
import { renderAdaptiveDiff, formatDiffStats } from './diff-renderer.js';
import { isDangerousShellCommand, isDangerousWritePath } from './danger.js';

function relPath(filePath: string): string {
  const cwd = process.cwd();
  return filePath.startsWith(cwd) ? filePath.slice(cwd.length).replace(/^[\\/]/, '') : filePath;
}

export type ConfirmChoice = 'yes' | 'yes_all_session' | 'no';

// ── Confirm prompt ──────────────────────────────────────────────────────────

/**
 * @param dangerous When true, this is a heuristically-detected destructive
 *   operation (see src/utils/danger.ts) — drop "Yes for all" entirely (it
 *   must not be skippable via a session-wide auto-approve) and default the
 *   cursor to "No" rather than "Yes".
 */
async function promptConfirm(kind: 'edit' | 'command' = 'edit', dangerous = false): Promise<ConfirmChoice> {
  const items = dangerous
    ? (kind === 'command'
        ? [
            { value: 'no', label: 'No — 拒绝执行' },
            { value: 'yes', label: 'Yes — 我确认要执行这条命令' },
          ]
        : [
            { value: 'no', label: 'No — 拒绝这次修改' },
            { value: 'yes', label: 'Yes — 我确认要写入这个文件' },
          ])
    : (kind === 'command'
        ? [
            { value: 'yes', label: 'Yes — 执行这条命令' },
            { value: 'yes_all_session', label: 'Yes for all — 本次会话中所有类似操作都自动执行' },
            { value: 'no', label: 'No — 拒绝执行' },
          ]
        : [
            { value: 'yes', label: 'Yes — 接受这次修改' },
            { value: 'yes_all_session', label: 'Yes for all — 本次会话中所有类似修改都自动接受' },
            { value: 'no', label: 'No — 拒绝这次修改' },
          ]);

  const baseLabel = kind === 'command' ? 'Confirm command' : 'Confirm edit';
  const label = dangerous
    ? chalk.red.bold('⚠ DANGEROUS — ') + baseLabel
    : baseLabel;
  const selected = await selectFromList(label, items, dangerous ? 'no' : undefined);
  if (selected === null) return 'no';
  return selected as ConfirmChoice;
}

/**
 * Show diff and prompt for confirmation. Accepts optional pre-read content
 * to avoid redundant disk read when the caller already has the file content.
 *
 * @returns The user's choice AND the original file content (so the caller
 *          can pass it to the tool to avoid a second read).
 */
export async function confirmEdit(
  filePath: string,
  newContent: string,
  preReadOriginal?: string,
  projectRoot: string = process.cwd(),
): Promise<{ choice: ConfirmChoice; originalContent: string }> {
  const absPath = resolve(filePath);
  const exists = preReadOriginal !== undefined ? preReadOriginal !== '' : existsSync(absPath);
  const oldContent = preReadOriginal !== undefined
    ? preReadOriginal
    : (exists ? await readFile(absPath, 'utf-8') : '');

  const { output: diffOutput, stats } = renderAdaptiveDiff(oldContent, newContent);

  const isNew = !exists;
  const fileLabel = (isNew ? chalk.green('new') : chalk.yellow('edit')) + '  ' + chalk.bold(relPath(absPath));
  const statsLine = stats.added > 0 || stats.removed > 0
    ? '  ' + formatDiffStats(stats.added, stats.removed)
    : '';

  process.stdout.write('\n  ' + fileLabel + statsLine + '\n\n');

  if (stats.added === 0 && stats.removed === 0 && !isNew) {
    process.stdout.write(chalk.gray('  (no changes)') + '\n');
  } else {
    process.stdout.write(diffOutput + '\n');
  }

  const dangerous = isDangerousWritePath(absPath, projectRoot);
  if (dangerous) {
    process.stdout.write('\n  ' + chalk.red.bold('⚠  该路径落在敏感目录/项目外，需要二次确认') + '\n');
  }

  process.stdout.write('\n');

  const choice = await promptConfirm('edit', dangerous);
  return { choice, originalContent: oldContent };
}

/**
 * Show a shell command and prompt for confirmation before executing it.
 * Mirrors confirmEdit's yes/yes_all_session/no flow so execute_shell gets
 * the same trust-mode gating as write_file/edit_file.
 */
export async function confirmShellCommand(command: string, cwd: string): Promise<ConfirmChoice> {
  const dangerous = isDangerousShellCommand(command);
  process.stdout.write('\n  ' + chalk.yellow('run') + '  ' + chalk.bold(command) + '\n');
  process.stdout.write(chalk.gray(`  cwd: ${cwd}`) + '\n');
  if (dangerous) {
    process.stdout.write('  ' + chalk.red.bold('⚠  检测到高危命令，需要二次确认') + '\n');
  }
  process.stdout.write('\n');
  return promptConfirm('command', dangerous);
}

/**
 * Simple yes/no confirmation prompt using the list picker UI.
 * Returns true if the user chose yes, false for no or cancelled.
 *
 * "No" is listed FIRST (index 0, the default-selected item) so pressing
 * Enter without moving the cursor aborts — this is a risk-gated prompt
 * (used after a step's quality check retries are exhausted), so the safe
 * choice must be the accidental one, not "continue anyway".
 */
export async function confirmYesNo(prompt: string): Promise<boolean> {
  process.stdout.write('\n' + chalk.yellow(prompt) + '\n');
  const items = [
    { value: 'no', label: 'No — 放弃' },
    { value: 'yes', label: 'Yes — 继续' },
  ];
  const selected = await selectFromList('', items);
  return selected === 'yes';
}

export function applyEdit(original: string, oldString: string, newString: string): string | null {
  if (!original.includes(oldString)) return null;
  // Reject ambiguous edits — old_string must appear exactly once so the replacement
  // target is unambiguous. If it appears more than once, require the caller to
  // provide more surrounding context to make the match unique.
  const firstIdx = original.indexOf(oldString);
  const lastIdx = original.lastIndexOf(oldString);
  if (firstIdx !== lastIdx) return 'AMBIGUOUS';
  return original.slice(0, firstIdx) + newString + original.slice(firstIdx + oldString.length);
}
