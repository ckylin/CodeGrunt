import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';
import { selectFromList } from './select.js';
import { renderAdaptiveDiff, formatDiffStats } from './diff-renderer.js';

function relPath(filePath: string): string {
  const cwd = process.cwd();
  return filePath.startsWith(cwd) ? filePath.slice(cwd.length).replace(/^[\\/]/, '') : filePath;
}

export type ConfirmChoice = 'yes' | 'yes_all_session' | 'no';

// ── Confirm prompt ──────────────────────────────────────────────────────────

async function promptConfirm(): Promise<ConfirmChoice> {
  const items = [
    { value: 'yes', label: 'Yes — 接受这次修改' },
    { value: 'yes_all_session', label: 'Yes for all — 本次会话中所有类似修改都自动接受' },
    { value: 'no', label: 'No — 拒绝这次修改' },
  ];

  const selected = await selectFromList('Confirm edit', items);
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

  process.stdout.write('\n');

  const choice = await promptConfirm();
  return { choice, originalContent: oldContent };
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
